const { app, BrowserWindow, Menu, Tray, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
const crypto = require('crypto');
const si = require('systeminformation');

app.disableHardwareAcceleration();
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // app.quit() solo programa la salida; no detiene la ejecución síncrona
  // del resto de este script. Sin el exit, la segunda instancia registraba
  // igualmente todos los handlers IPC y llegaba a crear una ventana y un
  // icono de bandeja reales (aunque fuera brevemente) antes de cerrarse.
  app.quit();
  process.exit(0);
}
let mainWindow = null;
let tray = null;

const IS_WIN = process.platform === 'win32';
const ICON_PATH = path.join(__dirname, 'icon.ico');
const HISTORY_FILE = path.join(app.getPath('userData'), 'vok-history.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'vok-settings.json');
const BACKUP_DIR = path.join(app.getPath('userData'), 'backups');

/* ─── Settings (window bounds, etc.) ────────────────────────────── */
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveSettings(patch) {
  try {
    const cur = loadSettings();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...cur, ...patch }));
  } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════════════
   PowerShell helper — robust, no quoting hell (Base64 EncodedCommand)
   ═══════════════════════════════════════════════════════════════════ */
// `input` (opcional): texto escrito a stdin del proceso y cerrado. Permite
// pasar datos (p.ej. rutas de registro con comillas o caracteres raros) sin
// interpolarlos como literales dentro del script — el script los lee con
// `[Console]::In.ReadToEnd()` en vez de que Node los concatene como texto.
// PowerShell escribe su salida en la codificación de consola del sistema
// (normalmente un codepage OEM, no UTF-8) salvo que se le indique lo
// contrario. Node decodifica stdout como UTF-8 por defecto, así que sin
// esto cualquier acento/ñ en nombres de servicios, rutas o entradas de
// registro llegaba corrupto al renderer.
const PS_FORCE_UTF8 = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n";
// Escaneos largos (apps sin usar, restos de configuración, juegos) se
// registran aquí por nombre mientras están en vuelo, para que cancel-scan
// pueda matarlos desde la UI. Los handlers de ps()/psJson() sin `name` no
// se registran (comportamiento idéntico al de siempre).
const activeScans = new Map();
function ps(script, { timeout = 20000, input, name } = {}) {
  return new Promise(resolve => {
    if (!IS_WIN) { resolve({ err: new Error('not windows'), stdout: '', stderr: '' }); return; }
    const encoded = Buffer.from(PS_FORCE_UTF8 + script, 'utf16le').toString('base64');
    const child = execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout, maxBuffer: 1024 * 1024 * 96, windowsHide: true },
      (err, stdout, stderr) => { if (name) activeScans.delete(name); resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() }); }
    );
    if (name) activeScans.set(name, child);
    if (input != null) { child.stdin.write(input, 'utf8'); child.stdin.end(); }
  });
}

ipcMain.handle('cancel-scan', async (e, name) => {
  const child = activeScans.get(name);
  if (!child) return { ok: false, error: 'No hay ningún escaneo activo con ese nombre' };
  try { await execAsync(`taskkill /PID ${child.pid} /T /F`); } catch (e2) {}
  activeScans.delete(name);
  return { ok: true };
});
// Antes esta función devolvía `null` para timeout, error de ejecución,
// salida vacía y JSON inválido por igual — la UI no podía distinguir
// "no hay nada que mostrar" de "algo falló". Ahora siempre resuelve con
// un sobre {ok, kind, error, data} explícito.
async function psJson(script, opts) {
  const r = await ps(script, opts);
  if (r.err) {
    const timedOut = r.err.killed || r.err.signal === 'SIGTERM' || /ETIMEDOUT/i.test(String(r.err.message || ''));
    return {
      ok: false,
      kind: timedOut ? 'timeout' : 'exec_error',
      error: r.stderr || r.err.message || 'PowerShell falló',
      data: null,
    };
  }
  if (!r.stdout) return { ok: true, kind: 'empty', error: null, data: null };
  try {
    return { ok: true, kind: 'ok', error: null, data: JSON.parse(r.stdout) };
  } catch (e) {
    return { ok: false, kind: 'parse_error', error: 'Respuesta inesperada de PowerShell', data: null };
  }
}
const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

/* ═══════════════════════════════════════════════════════════════════
   History persistence
   ═══════════════════════════════════════════════════════════════════ */
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { return []; }
}
function addHistory(op, detail, opts = {}) {
  try {
    const h = loadHistory();
    h.unshift({ ts: Date.now(), op, detail, freed: opts.freed || 0, status: opts.status || 'OK', durationMs: opts.durationMs || 0 });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h.slice(0, 300)));
  } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════════════
   ADMIN detection / elevation
   ═══════════════════════════════════════════════════════════════════ */
let isAdmin = false;

// Whitelist de la última llamada a scan-registry; ver clean-registry.
let lastRegistryScan = new Map();

async function checkAdmin() {
  if (!IS_WIN) { isAdmin = false; return false; }
  const r = await ps('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', { timeout: 6000 });
  isAdmin = /true/i.test(r.stdout);
  return isAdmin;
}

ipcMain.handle('is-admin', async () => isAdmin);

// Spawn an elevated copy of the app. Resolves true if the elevated process
// actually started (UAC accepted), false if the user cancelled the prompt.
// For the portable build, relaunch the ORIGINAL portable exe (a fresh
// extraction): the launcher deletes this instance's temp dir on exit, and the
// single-instance lock is released so the new copy isn't rejected.
function elevate() {
  return new Promise(resolve => {
    if (!IS_WIN) { resolve(false); return; }
    try { app.releaseSingleInstanceLock(); } catch (e) {}
    const exe = (process.env.PORTABLE_EXECUTABLE_FILE || process.execPath).replace(/'/g, "''");
    const args = app.isPackaged ? ['--elevated'] : [path.resolve(__dirname), '--elevated'];
    const argList = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
    const cmd = `try { Start-Process -FilePath '${exe}' -ArgumentList ${argList} -Verb RunAs -ErrorAction Stop; 'OK' } catch { 'CANCEL' }`;
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 120000 },
      (err, stdout) => resolve(/OK/.test(stdout || '')));
  });
}

ipcMain.handle('relaunch-admin', async () => {
  if (!IS_WIN) return { ok: false };
  const launched = await elevate();
  if (launched) { app.isQuiting = true; setTimeout(() => app.quit(), 300); return { ok: true }; }
  return { ok: false, error: 'Elevación cancelada' };
});

/* ═══════════════════════════════════════════════════════════════════
   REAL-TIME METRICS  (systeminformation + one PS call for GPU/temp/threads)
   ═══════════════════════════════════════════════════════════════════ */
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

async function gpuTempThreads() {
  if (!IS_WIN) return { gpu: -1, temp: -1, threads: 0 };
  const script = `
$gpu = -1
try {
  # Filtrar a motores engtype_3D: ~660ms frente a ~2250ms leyendo las ~369
  # instancias totales, y evita sumar el mismo trabajo contado por varios
  # tipos de motor (que podía dar un agregado por encima del 100%).
  $s = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
  if ($s) { $gpu = [math]::Min(100, [math]::Round((($s | Measure-Object CookedValue -Sum).Sum), 0)) }
} catch {}
$temp = -1
try { $t = Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi -ErrorAction SilentlyContinue; if ($t) { $temp = [math]::Round((($t[0].CurrentTemperature) - 2732) / 10, 0) } } catch {}
$threads = 0
try { $threads = (Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum } catch {}
Write-Output "$gpu|$temp|$threads"`;
  const r = await ps(script, { timeout: 6000 });
  const p = (r.stdout || '').split('|');
  return { gpu: parseInt(p[0]), temp: parseInt(p[1]), threads: parseInt(p[2]) || 0 };
}

// Evita procesos powershell.exe superpuestos si get-metrics se invoca de
// nuevo antes de que la lectura anterior termine (defensa adicional al
// guard del renderer; cubre cualquier otro llamador futuro de este handler).
let metricsInFlight = null;
ipcMain.handle('get-metrics', async () => {
  if (metricsInFlight) return metricsInFlight;
  metricsInFlight = getMetricsOnce().finally(() => { metricsInFlight = null; });
  return metricsInFlight;
});

async function getMetricsOnce() {
  try {
    const [load, mem, fsSize, net, procs, speed, time, gtt] = await Promise.all([
      si.currentLoad().catch(() => ({ currentLoad: 0 })),
      si.mem().catch(() => ({ total: os.totalmem(), available: os.freemem() })),
      si.fsSize().catch(() => []),
      si.networkStats().catch(() => []),
      si.processes().catch(() => ({ all: 0, list: [] })),
      si.cpuCurrentSpeed().catch(() => ({ avg: 0 })),
      si.time(),
      gpuTempThreads(),
    ]);

    const total = mem.total || os.totalmem();
    const available = mem.available != null ? mem.available : os.freemem();
    const used = total - available;

    const sysDrive = (process.env.SystemDrive || 'C:').replace('\\', '');
    let diskPct = 0;
    const sys = fsSize.find(d => (d.mount || '').toUpperCase().startsWith(sysDrive.toUpperCase())) || fsSize[0];
    if (sys && sys.size) diskPct = Math.round(sys.use != null ? sys.use : ((sys.used / sys.size) * 100));

    const netMbps = +(net.reduce((s, n) => s + (n.rx_sec || 0) + (n.tx_sec || 0), 0) / 1048576).toFixed(1);

    const topProcs = (procs.list || [])
      .sort((a, b) => (b.memRss || b.mem_rss || 0) - (a.memRss || a.mem_rss || 0))
      .slice(0, 6)
      .map(p => ({ Name: p.name, CPU: +(p.cpu || 0).toFixed(1), MemMB: Math.round((p.memRss || p.mem_rss || 0) / 1024), pid: p.pid }));

    return {
      cpu: Math.round(load.currentLoad || 0),
      ram: {
        totalGB: +(total / 1073741824).toFixed(1),
        usedGB: +(used / 1073741824).toFixed(1),
        freeGB: +(available / 1073741824).toFixed(1),
        pct: Math.round((used / total) * 100),
      },
      ext: {
        gpu: gtt.gpu, temp: gtt.temp, diskPct,
        netMbps: isNaN(netMbps) ? 0 : netMbps,
        procs: procs.all || (procs.list ? procs.list.length : 0),
        threads: gtt.threads,
        cpuFreq: +(speed.avg || 0).toFixed(2),
        uptime: fmtUptime(time.uptime || 0),
      },
      topProcs,
    };
  } catch (e) {
    return { cpu: 0, ram: { totalGB: 0, usedGB: 0, freeGB: 0, pct: 0 }, ext: { gpu: -1, temp: -1, diskPct: 0, netMbps: 0, procs: 0, threads: 0, cpuFreq: 0, uptime: '—' }, topProcs: [] };
  }
}

ipcMain.handle('get-system-info', async () => {
  try {
    const [cpu, gfx, osInfo, sys, disks, bat] = await Promise.all([
      si.cpu().catch(() => ({})), si.graphics().catch(() => ({ controllers: [] })),
      si.osInfo().catch(() => ({})), si.system().catch(() => ({})),
      si.diskLayout().catch(() => []), si.battery().catch(() => ({ hasBattery: false })),
    ]);
    const gpu = (gfx.controllers || []).map(c => c.model).filter(Boolean)[0] || '—';
    return {
      cpu: `${cpu.manufacturer || ''} ${cpu.brand || ''}`.trim() || '—',
      cores: `${cpu.physicalCores || cpu.cores || '?'}C / ${cpu.cores || '?'}T`,
      gpu,
      os: `${osInfo.distro || ''} ${osInfo.release || ''} (build ${osInfo.build || '?'})`.trim(),
      arch: osInfo.arch || '',
      board: `${sys.manufacturer || ''} ${sys.model || ''}`.trim() || '—',
      disk: (disks[0] && `${disks[0].name || ''} ${disks[0].type || ''}`.trim()) || '—',
      ramGB: +(os.totalmem() / 1073741824).toFixed(0),
      battery: bat.hasBattery ? `${bat.percent}%${bat.isCharging ? ' (cargando)' : ''}` : 'N/A',
      hostname: osInfo.hostname || os.hostname(),
    };
  } catch (e) { return {}; }
});

/* ═══════════════════════════════════════════════════════════════════
   DISK CLEANUP — real scan (sizes/counts) + real clean
   ═══════════════════════════════════════════════════════════════════ */
const JUNK_CATS = [
  { id: 'temp_user', label: 'Temporales del usuario', risk: 'SEGURO', olderThanHours: 24 },
  { id: 'temp_win', label: 'Temporales de Windows', risk: 'SEGURO', olderThanHours: 24 },
  { id: 'recycle', label: 'Papelera de reciclaje', risk: 'IRREVERSIBLE', irreversible: true },
  { id: 'thumbs', label: 'Miniaturas (thumbcache)', risk: 'SEGURO' },
  { id: 'browser', label: 'Caché de navegadores', risk: 'SEGURO' },
  { id: 'wer', label: 'Reportes de errores (WER)', risk: 'SEGURO' },
  { id: 'dumps', label: 'Volcados de memoria', risk: 'SEGURO' },
  { id: 'delivery', label: 'Delivery Optimization', risk: 'SEGURO' },
  { id: 'winupdate', label: 'Caché de Windows Update', risk: 'REVISAR' },
  { id: 'prefetch', label: 'Prefetch de Windows', risk: 'REVISAR' },
];

// PowerShell that resolves the path list for each category (kept in one place)
const PS_JUNK_PATHS = `
function P($id) {
  switch ($id) {
    'temp_user'  { return @($env:TEMP) }
    'temp_win'   { return @("$env:SystemRoot\\Temp") }
    'thumbs'     { return @("$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\thumbcache_*.db", "$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\iconcache_*.db") }
    'browser'    { return @(
        # '*' en vez de 'Default': cubre también Profile 1, Profile 2... de
        # usuarios con varios perfiles de Chrome/Edge, no solo el primero.
        "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\*\\Cache",
        "$env:LOCALAPPDATA\\Google\\Chrome\\User Data\\*\\Code Cache",
        "$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data\\*\\Cache",
        "$env:LOCALAPPDATA\\Microsoft\\Edge\\User Data\\*\\Code Cache",
        # Antes apuntaba a la carpeta Profiles entera: habría borrado
        # historial, contraseñas y marcadores además de la caché. cache2 es
        # el subdirectorio real de caché de Firefox dentro de cada perfil.
        "$env:LOCALAPPDATA\\Mozilla\\Firefox\\Profiles\\*\\cache2") }
    'wer'        { return @("$env:ProgramData\\Microsoft\\Windows\\WER\\ReportQueue", "$env:ProgramData\\Microsoft\\Windows\\WER\\ReportArchive", "$env:LOCALAPPDATA\\Microsoft\\Windows\\WER") }
    'dumps'      { return @("$env:SystemRoot\\Minidump", "$env:LOCALAPPDATA\\CrashDumps") }
    'delivery'   { return @("$env:SystemRoot\\SoftwareDistribution\\DeliveryOptimization") }
    'winupdate'  { return @("$env:SystemRoot\\SoftwareDistribution\\Download") }
    'prefetch'   { return @("$env:SystemRoot\\Prefetch") }
  }
  return @()
}
# Solo aplica a categorías con corte temporal (temp_user/temp_win); evita borrar
# archivos que otro proceso pueda tener abiertos en este mismo instante, y nunca
# toca el propio proceso (PID actual) ni su árbol de trabajo.
function CutoffHours($id) {
  switch ($id) { 'temp_user' { return 24 } 'temp_win' { return 24 } }
  return 0
}
$ownPid = $PID`;

ipcMain.handle('scan-junk', async () => {
  const ids = JUNK_CATS.map(c => c.id);
  const script = `
${PS_JUNK_PATHS}
$ids = @(${ids.map(i => `'${i}'`).join(',')})
$out = @()
foreach ($id in $ids) {
  $size = [int64]0; $count = 0
  if ($id -eq 'recycle') {
    try {
      $sh = New-Object -ComObject Shell.Application
      $rb = $sh.Namespace(10)
      if ($rb) { foreach ($it in $rb.Items()) { try { $size += [int64]$it.Size; $count++ } catch {} } }
    } catch {}
  } else {
    $hrs = CutoffHours $id
    $cutoff = if ($hrs -gt 0) { (Get-Date).AddHours(-$hrs) } else { $null }
    foreach ($p in (P $id)) {
      try {
        if ($p -like '*[*]*') {
          # -Recurse: cuando el comodín está en mitad de la ruta (p.ej.
          # "User Data\*\Cache") esto resuelve el directorio de cada perfil
          # y hay que bajar dentro de él; para los globs de archivo suelto
          # (thumbcache_*.db) -Recurse no cambia nada porque no son contenedores.
          Get-ChildItem -Path $p -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
            if ($cutoff -and $_.LastWriteTime -gt $cutoff) { return }
            $size += [int64]$_.Length; $count++
          }
        } elseif (Test-Path -LiteralPath $p) {
          Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
            if ($cutoff -and $_.LastWriteTime -gt $cutoff) { return }
            $size += [int64]$_.Length; $count++
          }
        }
      } catch {}
    }
  }
  $out += [pscustomobject]@{ id = $id; size = $size; count = $count }
}
$out | ConvertTo-Json -Compress`;
  const r = await psJson(script, { timeout: 60000 });
  if (!r.ok) return { ok: false, error: r.error };
  const byId = {};
  asArray(r.data).forEach(d => { byId[d.id] = d; });
  return {
    ok: true,
    data: JUNK_CATS.map(c => ({
      ...c,
      sizeBytes: (byId[c.id] && byId[c.id].size) || 0,
      count: (byId[c.id] && byId[c.id].count) || 0,
    })),
  };
});

ipcMain.handle('clean-junk', async (e, selectedIds) => {
  if (!IS_WIN) return { ok: false, freed: 0 };
  const t0 = Date.now();
  const ids = (selectedIds || []).filter(id => JUNK_CATS.some(c => c.id === id));
  const script = `
${PS_JUNK_PATHS}
$ids = @(${ids.map(i => `'${i}'`).join(',')})
$freed = [int64]0
foreach ($id in $ids) {
  if ($id -eq 'recycle') {
    try { Clear-RecycleBin -Force -ErrorAction SilentlyContinue } catch {}
    continue
  }
  $hrs = CutoffHours $id
  $cutoff = if ($hrs -gt 0) { (Get-Date).AddHours(-$hrs) } else { $null }
  foreach ($p in (P $id)) {
    try {
      if ($p -like '*[*]*') {
        Get-ChildItem -Path $p -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
          if ($cutoff -and $_.LastWriteTime -gt $cutoff) { return }
          try { $freed += [int64]$_.Length; Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {}
        }
      } elseif (Test-Path -LiteralPath $p) {
        Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
          if ($cutoff -and $_.LastWriteTime -gt $cutoff) { return }
          try { $freed += [int64]$_.Length; Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {}
        }
        if (-not $cutoff) {
          Get-ChildItem -LiteralPath $p -Recurse -Force -Directory -ErrorAction SilentlyContinue | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue } catch {}
          }
        }
      }
    } catch {}
  }
}
Write-Output $freed`;
  const r = await ps(script, { timeout: 120000 });
  if (r.err) {
    addHistory('Limpieza de archivos', 'Falló: ' + (r.stderr || r.err.message), { status: 'ERROR', durationMs: Date.now() - t0 });
    return { ok: false, error: r.stderr || r.err.message || 'PowerShell falló', freed: 0 };
  }
  const freed = parseInt((r.stdout || '0').trim()) || 0;
  addHistory('Limpieza de archivos', `${ids.length} categorías`, { freed, durationMs: Date.now() - t0 });
  return { ok: true, freed };
});

/* ═══════════════════════════════════════════════════════════════════
   SERVICES — real list + start/stop + startup type
   ═══════════════════════════════════════════════════════════════════ */
// Curated, well-known optimizable services. impact = how much you typically gain by stopping.
const SVC_META = {
  SysMain:        { label: 'SysMain (Superfetch)',     impact: 'ALTO',  safe: true,  desc: 'Precarga apps; útil con HDD, poco con SSD' },
  WSearch:        { label: 'Windows Search',           impact: 'ALTO',  safe: true,  desc: 'Indexado de archivos' },
  DiagTrack:      { label: 'Telemetría (DiagTrack)',   impact: 'MEDIO', safe: true,  desc: 'Datos de diagnóstico a Microsoft' },
  wuauserv:       { label: 'Windows Update',           impact: 'MEDIO', safe: false, desc: 'Actualizaciones de seguridad' },
  Spooler:        { label: 'Cola de impresión',        impact: 'BAJO',  safe: true,  desc: 'Necesario solo si imprimes' },
  XblAuthManager: { label: 'Xbox Live Auth',           impact: 'BAJO',  safe: true,  desc: 'Servicios de Xbox' },
  XboxNetApiSvc:  { label: 'Xbox Networking',          impact: 'BAJO',  safe: true,  desc: 'Red de Xbox' },
  MapsBroker:     { label: 'Mapas descargados',        impact: 'BAJO',  safe: true,  desc: 'Mapas sin conexión' },
  RemoteRegistry: { label: 'Registro remoto',          impact: 'BAJO',  safe: true,  desc: 'Riesgo de seguridad; mejor desactivado' },
  Fax:            { label: 'Fax',                       impact: 'BAJO',  safe: true,  desc: 'Servicio de fax' },
  WMPNetworkSvc:  { label: 'Uso compartido WMP',        impact: 'BAJO',  safe: true,  desc: 'Compartir multimedia de WMP' },
  RetailDemo:     { label: 'Modo demo (tienda)',       impact: 'BAJO',  safe: true,  desc: 'Solo equipos de exposición' },
  lfsvc:          { label: 'Geolocalización',          impact: 'BAJO',  safe: true,  desc: 'Servicio de ubicación' },
  CDPSvc:         { label: 'Connected Devices',        impact: 'BAJO',  safe: true,  desc: 'Sincronización entre dispositivos' },
};

ipcMain.handle('list-services', async () => {
  const names = Object.keys(SVC_META);
  const script = `
$names = @(${names.map(n => `'${n}'`).join(',')})
Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name } |
  Select-Object Name, DisplayName, State, StartMode | ConvertTo-Json -Compress`;
  const r = await psJson(script, { timeout: 15000 });
  if (!r.ok) return { ok: false, error: r.error };
  const data = asArray(r.data);
  return {
    ok: true,
    data: names.map(n => {
      const row = data.find(d => d.Name === n) || {};
      const meta = SVC_META[n];
      return {
        name: n,
        label: meta.label,
        display: row.DisplayName || meta.label,
        state: row.State || 'Desconocido',
        startMode: row.StartMode || '—',
        impact: meta.impact,
        safe: meta.safe,
        desc: meta.desc,
        present: !!row.Name,
      };
    }).filter(s => s.present),
  };
});

ipcMain.handle('set-service', async (e, name, action) => {
  if (!IS_WIN) return { ok: false };
  if (!SVC_META[name]) return { ok: false, error: 'Servicio no permitido' };
  let cmd = '';
  if (action === 'start') cmd = `Start-Service -Name '${name}' -ErrorAction Stop`;
  else if (action === 'stop') cmd = `Stop-Service -Name '${name}' -Force -ErrorAction Stop`;
  else if (action === 'disable') cmd = `Stop-Service -Name '${name}' -Force -ErrorAction SilentlyContinue; Set-Service -Name '${name}' -StartupType Disabled -ErrorAction Stop`;
  else if (action === 'manual') cmd = `Set-Service -Name '${name}' -StartupType Manual -ErrorAction Stop`;
  else if (action === 'auto') cmd = `Set-Service -Name '${name}' -StartupType Automatic -ErrorAction Stop`;
  else return { ok: false, error: 'Acción inválida' };
  const r = await ps(`try { ${cmd}; Write-Output 'OK' } catch { Write-Output ('ERR:' + $_.Exception.Message) }`, { timeout: 15000 });
  if (/^OK/.test(r.stdout)) { addHistory('Servicio', `${name} → ${action}`); return { ok: true }; }
  const msg = (r.stdout || r.stderr || '').replace(/^ERR:/, '');
  return { ok: false, error: msg || (isAdmin ? 'Falló la operación' : 'Requiere administrador') };
});

/* ═══════════════════════════════════════════════════════════════════
   STARTUP MANAGER — real list + reversible enable/disable (StartupApproved)
   ═══════════════════════════════════════════════════════════════════ */
ipcMain.handle('list-startup', async () => {
  const script = `
$result = New-Object System.Collections.ArrayList
function Approved-Enabled($apPath, $name) {
  try {
    $v = (Get-ItemProperty -LiteralPath $apPath -Name $name -ErrorAction Stop).$name
    if ($v -and ($v[0] -band 1)) { return $false }
  } catch {}
  return $true
}
$runs = @(
  @{ hive='HKCU'; run='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; ap='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' },
  @{ hive='HKLM'; run='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; ap='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' }
)
foreach ($rk in $runs) {
  if (Test-Path $rk.run) {
    $props = Get-ItemProperty -Path $rk.run
    foreach ($pr in $props.PSObject.Properties) {
      if ($pr.Name -like 'PS*') { continue }
      $en = Approved-Enabled $rk.ap $pr.Name
      [void]$result.Add([pscustomobject]@{ name=$pr.Name; command=[string]$pr.Value; location=$rk.hive; source='Run'; approvedName=$pr.Name; enabled=$en })
    }
  }
}
$folders = @(
  @{ dir="$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"; hive='HKCU' },
  @{ dir="$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"; hive='HKLM' }
)
$apFolderCU = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'
$apFolderLM = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'
foreach ($f in $folders) {
  if (Test-Path $f.dir) {
    Get-ChildItem -Path $f.dir -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
      $ap = if ($f.hive -eq 'HKCU') { $apFolderCU } else { $apFolderLM }
      $en = Approved-Enabled $ap $_.Name
      [void]$result.Add([pscustomobject]@{ name=$_.BaseName; command=$_.FullName; location=$f.hive; source='Folder'; approvedName=$_.Name; enabled=$en })
    }
  }
}
$result | ConvertTo-Json -Compress`;
  const r = await psJson(script, { timeout: 15000 });
  return r.ok ? { ok: true, data: asArray(r.data) } : { ok: false, error: r.error };
});

ipcMain.handle('toggle-startup', async (e, item, enable) => {
  if (!IS_WIN) return { ok: false };
  const base = item.location === 'HKLM'
    ? 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved'
    : 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
  const sub = item.source === 'Folder' ? 'StartupFolder' : 'Run';
  const apPath = `${base}\\${sub}`;
  const bytes = enable ? '2,0,0,0,0,0,0,0,0,0,0,0' : '3,0,0,0,0,0,0,0,0,0,0,0';
  const safeName = (item.approvedName || item.name).replace(/'/g, "''");
  const script = `
try {
  if (-not (Test-Path '${apPath}')) { New-Item -Path '${apPath}' -Force | Out-Null }
  $b = [byte[]]@(${bytes})
  Set-ItemProperty -Path '${apPath}' -Name '${safeName}' -Value $b -Type Binary -ErrorAction Stop
  Write-Output 'OK'
} catch { Write-Output ('ERR:' + $_.Exception.Message) }`;
  const r = await ps(script, { timeout: 10000 });
  if (/^OK/.test(r.stdout)) { addHistory('Arranque', `${item.name} → ${enable ? 'activado' : 'desactivado'}`); return { ok: true }; }
  return { ok: false, error: (r.stdout || '').replace(/^ERR:/, '') || (item.location === 'HKLM' && !isAdmin ? 'Requiere administrador' : 'Falló') };
});

/* ═══════════════════════════════════════════════════════════════════
   RAM OPTIMIZATION — real working-set trim (EmptyWorkingSet)
   ═══════════════════════════════════════════════════════════════════ */
async function memAvailable() {
  try { const m = await si.mem(); return m.available; } catch (e) { return os.freemem(); }
}

ipcMain.handle('free-ram', async () => {
  if (!IS_WIN) return { ok: false, freed: 0 };
  const before = await memAvailable();
  const script = `
$sig = @"
using System;
using System.Runtime.InteropServices;
public class VokMem { [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr hProcess); }
"@
try { Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue } catch {}
$n = 0
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  try { [void][VokMem]::EmptyWorkingSet($_.Handle); $n++ } catch {}
}
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
Write-Output $n`;
  const r = await ps(script, { timeout: 30000 });
  // Una sola muestra 600ms después es ruidosa: el contador de memoria
  // disponible de Windows fluctúa por actividad ajena a esta operación. Se
  // toman varias muestras y se usa la mejor (más disponible), para no
  // reportar "0 liberados" solo porque otro proceso reservó memoria justo
  // en el instante del muestreo.
  let after = before;
  for (let i = 0; i < 3; i++) {
    await new Promise(res => setTimeout(res, 500));
    after = Math.max(after, await memAvailable());
  }
  const freed = Math.max(0, after - before);
  addHistory('Liberar RAM', `${parseInt(r.stdout) || 0} procesos`, { freed });
  return { ok: true, freed, procs: parseInt(r.stdout) || 0 };
});

// Procesos cuya terminación puede colgar o cerrar la sesión de Windows.
// Comparación por nombre de imagen (minúsculas, sin .exe).
const PROTECTED_PROCESSES = new Set([
  'system', 'system idle process', 'registry', 'smss', 'csrss', 'wininit',
  'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'explorer', 'dwm',
  'fontdrvhost', 'sihost', 'ctfmon', 'taskhostw', 'runtimebroker',
  'searchindexer', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost',
  'audiodg', 'spoolsv', 'wudfhost', 'memcompression',
]);

ipcMain.handle('kill-process', async (e, pid) => {
  if (!IS_WIN || !pid) return { ok: false };
  const pidNum = parseInt(pid);
  if (!Number.isFinite(pidNum) || pidNum <= 0) return { ok: false, error: 'PID inválido' };
  if (pidNum === process.pid) return { ok: false, error: 'No se puede terminar el propio Vokoptimizer' };
  const r = await ps(`
try {
  $p = Get-Process -Id ${pidNum} -ErrorAction Stop
  Write-Output ('NAME:' + $p.ProcessName)
} catch { Write-Output 'ERR:no existe ese proceso' }`, { timeout: 8000 });
  const out = (r.stdout || '').trim();
  if (!out.startsWith('NAME:')) return { ok: false, error: out.replace(/^ERR:/, '') || 'proceso no encontrado' };
  const name = out.slice(5).trim().toLowerCase();
  if (PROTECTED_PROCESSES.has(name) || pidNum <= 4) {
    return { ok: false, error: `"${name}" es un proceso protegido del sistema` };
  }
  const kr = await ps(`try { Stop-Process -Id ${pidNum} -Force -ErrorAction Stop; Write-Output 'OK' } catch { Write-Output ('ERR:' + $_.Exception.Message) }`, { timeout: 8000 });
  return /^OK/.test(kr.stdout) ? { ok: true } : { ok: false, error: (kr.stdout || '').replace(/^ERR:/, '') };
});

/* ═══════════════════════════════════════════════════════════════════
   POWER PROFILES / GAME / QUIET MODE
   ═══════════════════════════════════════════════════════════════════ */
const POWER_GUIDS = {
  gaming: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
  trabajo: 'a1841308-3541-4fab-bc81-f71556f20b4a',
  balanced: '381b4222-f694-41f0-9685-ff5bb260df2e',
  ultimate: 'e9a42b02-d5df-448d-aa00-03f14749eb61',
};

function execAsync(cmd, timeout = 12000) {
  return new Promise(resolve => exec(cmd, { timeout, windowsHide: true }, (err) => resolve(!err)));
}

function execOut(cmd, timeout = 12000) {
  return new Promise(resolve => exec(cmd, { timeout, windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: stdout || '' })));
}

// `powercfg -duplicatescheme` crea un plan de energía NUEVO cada vez que se
// llama — sin caché, cada aplicación del perfil "ultimate" iba dejando un
// "Ultra rendimiento (N)" más en el sistema. Ahora el GUID duplicado se
// persiste en settings y solo se vuelve a duplicar si ya no existe.
async function ensureUltimateGuid() {
  const settings = loadSettings();
  if (settings.ultimateGuid) {
    const check = await execOut(`powercfg /query ${settings.ultimateGuid}`);
    if (check.ok) return settings.ultimateGuid;
  }
  const dup = await execOut(`powercfg -duplicatescheme ${POWER_GUIDS.ultimate}`);
  const m = dup.stdout.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  const guid = m ? m[1] : POWER_GUIDS.ultimate;
  saveSettings({ ultimateGuid: guid });
  return guid;
}

ipcMain.handle('set-power-profile', async (e, profile) => {
  if (!IS_WIN) return { ok: false };
  let guid = POWER_GUIDS[profile] || POWER_GUIDS.balanced;
  // The Ultimate Performance plan often isn't registered; duplicating it registers it (and may assign a new GUID).
  if (profile === 'ultimate') guid = await ensureUltimateGuid();
  const ok = await execAsync(`powercfg /setactive ${guid}`);
  addHistory('Plan de energía', profile);
  return { ok };
});

// Multimedia class scheduler keys — the real Windows latency knobs.
const MMCSS = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile';
const MMCSS_GAMES = MMCSS + '\\Tasks\\Games';

async function psOk(script) {
  const r = await ps(`try { ${script}; Write-Output 'OK' } catch { Write-Output ('ERR:' + $_.Exception.Message) }`, { timeout: 15000 });
  return /OK/.test(r.stdout);
}

// Applies a full optimization profile and reports each step's outcome.
async function applyProfile(id) {
  if (!IS_WIN) return { ok: false, steps: [] };
  const steps = [];
  const run = async (label, fn) => { let ok = false; try { ok = (await fn()) !== false; } catch (e) { ok = false; } steps.push({ label, ok }); };

  if (id === 'gaming') {
    await run('Plan de energía: Alto rendimiento', () => execAsync(`powercfg /setactive ${POWER_GUIDS.gaming}`));
    await run('Prioridad multimedia máxima', () => psOk(
      `Set-ItemProperty -Path '${MMCSS}' -Name SystemResponsiveness -Value 10 -Type DWord -ErrorAction Stop`));
    await run('Red sin throttling (latencia mínima)', () => psOk(
      `Set-ItemProperty -Path '${MMCSS}' -Name NetworkThrottlingIndex -Value 0xffffffff -Type DWord -ErrorAction Stop`));
    await run('Prioridad GPU/CPU alta para juegos', () => psOk(`
if (-not (Test-Path '${MMCSS_GAMES}')) { New-Item -Path '${MMCSS_GAMES}' -Force | Out-Null }
Set-ItemProperty -Path '${MMCSS_GAMES}' -Name 'GPU Priority' -Value 8 -Type DWord -ErrorAction Stop
Set-ItemProperty -Path '${MMCSS_GAMES}' -Name 'Priority' -Value 6 -Type DWord -ErrorAction Stop
Set-ItemProperty -Path '${MMCSS_GAMES}' -Name 'Scheduling Category' -Value 'High' -ErrorAction Stop
Set-ItemProperty -Path '${MMCSS_GAMES}' -Name 'SFIO Priority' -Value 'High' -ErrorAction Stop`));
    await run('Game Mode ON · captura DVR OFF', () => psOk(`
reg add "HKCU\\SOFTWARE\\Microsoft\\GameBar" /v AutoGameModeEnabled /t REG_DWORD /d 1 /f | Out-Null
reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR" /v AppCaptureEnabled /t REG_DWORD /d 0 /f | Out-Null
reg add "HKCU\\System\\GameConfigStore" /v GameDVR_Enabled /t REG_DWORD /d 0 /f | Out-Null`));
    await run('Detener SysMain, WSearch y telemetría', () => psOk(`
Stop-Service SysMain -Force -ErrorAction SilentlyContinue
Stop-Service WSearch -Force -ErrorAction SilentlyContinue
Stop-Service DiagTrack -Force -ErrorAction SilentlyContinue`));
    await run('Vaciar caché DNS', () => execAsync('ipconfig /flushdns'));
  } else if (id === 'trabajo') {
    await run('Plan de energía: Economizador', () => execAsync(`powercfg /setactive ${POWER_GUIDS.trabajo}`));
    await run('Detener telemetría (DiagTrack)', () => psOk('Stop-Service DiagTrack -Force -ErrorAction SilentlyContinue'));
    await run('Detener precarga SysMain (menos disco)', () => psOk('Stop-Service SysMain -Force -ErrorAction SilentlyContinue'));
    await run('CPU a frecuencia reducida', async () => {
      await execAsync('powercfg /setacvalueindex scheme_current sub_processor PROCTHROTTLEMAX 80');
      return execAsync('powercfg /setactive scheme_current');
    });
  } else if (id === 'balanced') {
    await run('Plan de energía: Equilibrado', () => execAsync(`powercfg /setactive ${POWER_GUIDS.balanced}`));
    // "Equilibrado" es el perfil de vuelta al estado normal: revierte
    // explícitamente el tope de CPU que deja el perfil "trabajo" en vez de
    // asumir que el plan Equilibrado nunca se tocó (si Windows lo dejó
    // marcado por otra vía, aquí queda garantizado sin restricción).
    await run('CPU sin restricciones', async () => {
      await execAsync('powercfg /setacvalueindex scheme_current sub_processor PROCTHROTTLEMIN 5');
      await execAsync('powercfg /setacvalueindex scheme_current sub_processor PROCTHROTTLEMAX 100');
      return execAsync('powercfg /setactive scheme_current');
    });
    await run('Restaurar prioridad multimedia y red', () => psOk(`
Set-ItemProperty -Path '${MMCSS}' -Name SystemResponsiveness -Value 20 -Type DWord -ErrorAction Stop
Set-ItemProperty -Path '${MMCSS}' -Name NetworkThrottlingIndex -Value 10 -Type DWord -ErrorAction Stop`));
    await run('Prioridades de juegos por defecto', () => psOk(`
if (Test-Path '${MMCSS_GAMES}') {
  Set-ItemProperty -Path '${MMCSS_GAMES}' -Name 'Priority' -Value 2 -Type DWord -ErrorAction SilentlyContinue
  Set-ItemProperty -Path '${MMCSS_GAMES}' -Name 'Scheduling Category' -Value 'Medium' -ErrorAction SilentlyContinue
  Set-ItemProperty -Path '${MMCSS_GAMES}' -Name 'SFIO Priority' -Value 'Normal' -ErrorAction SilentlyContinue
}`));
    await run('Reactivar SysMain, WSearch y DVR', () => psOk(`
Start-Service SysMain -ErrorAction SilentlyContinue
Start-Service WSearch -ErrorAction SilentlyContinue
Start-Service DiagTrack -ErrorAction SilentlyContinue
reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR" /v AppCaptureEnabled /t REG_DWORD /d 1 /f | Out-Null
reg add "HKCU\\System\\GameConfigStore" /v GameDVR_Enabled /t REG_DWORD /d 1 /f | Out-Null`));
  } else if (id === 'ultimate') {
    await run('Plan Ultimate Performance', async () => {
      const guid = await ensureUltimateGuid();
      return execAsync(`powercfg /setactive ${guid}`);
    });
    await run('CPU mínima al 100% (sin throttling)', async () => {
      await execAsync('powercfg /setacvalueindex scheme_current sub_processor PROCTHROTTLEMIN 100');
      await execAsync('powercfg /setacvalueindex scheme_current sub_processor PROCTHROTTLEMAX 100');
      return execAsync('powercfg /setactive scheme_current');
    });
    await run('Suspensión selectiva USB desactivada', async () => {
      await execAsync('powercfg /setacvalueindex scheme_current 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0');
      return execAsync('powercfg /setactive scheme_current');
    });
    await run('Prioridad multimedia máxima', () => psOk(
      `Set-ItemProperty -Path '${MMCSS}' -Name SystemResponsiveness -Value 10 -Type DWord -ErrorAction Stop`));
  } else {
    return { ok: false, steps: [], error: 'Perfil desconocido' };
  }

  const okCount = steps.filter(s => s.ok).length;
  addHistory('Perfil', `${id} (${okCount}/${steps.length} pasos)`, { status: okCount === steps.length ? 'OK' : 'WARN' });
  return { ok: okCount > 0, steps, partial: okCount < steps.length };
}

ipcMain.handle('apply-profile', async (e, id) => applyProfile(String(id)));

// Legacy entry points (quick actions) — routed through the profile engine.
ipcMain.handle('set-game-mode', async (e, enable) => applyProfile(enable ? 'gaming' : 'balanced'));
ipcMain.handle('set-quiet-mode', async (e, enable) => applyProfile(enable ? 'trabajo' : 'balanced'));

/* ═══════════════════════════════════════════════════════════════════
   NETWORK
   ═══════════════════════════════════════════════════════════════════ */
ipcMain.handle('flush-dns', async () => {
  if (!IS_WIN) return { ok: false };
  const ok = await execAsync('ipconfig /flushdns');
  addHistory('Red', 'Caché DNS vaciada');
  return { ok };
});

ipcMain.handle('network-reset', async () => {
  if (!IS_WIN) return { ok: false };
  const r = await ps(`
try {
  ipconfig /flushdns | Out-Null
  netsh winsock reset | Out-Null
  netsh int ip reset | Out-Null
  Write-Output 'OK'
} catch { Write-Output ('ERR:' + $_.Exception.Message) }`, { timeout: 20000 });
  const ok = /^OK/.test(r.stdout);
  if (ok) addHistory('Red', 'Pila de red reiniciada (requiere reinicio)');
  return { ok, reboot: ok, error: ok ? null : (isAdmin ? 'Falló' : 'Requiere administrador') };
});

/* ═══════════════════════════════════════════════════════════════════
   REGISTRY — real, conservative orphan scan + backup-first clean
   ═══════════════════════════════════════════════════════════════════ */
ipcMain.handle('scan-registry', async () => {
  const script = `
$findings = New-Object System.Collections.ArrayList
function ToReg($psPath) { return ($psPath -replace '^Microsoft\\.PowerShell\\.Core\\\\Registry::','' -replace '^HKEY_LOCAL_MACHINE','HKLM' -replace '^HKEY_CURRENT_USER','HKCU') }

# 1) Orphaned uninstall entries (InstallLocation that no longer exists)
$uninst = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($u in $uninst) {
  if (-not (Test-Path $u)) { continue }
  Get-ChildItem $u -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p.DisplayName -and $p.InstallLocation) {
      $loc = $p.InstallLocation.Trim()
      if ($loc.Length -gt 3 -and -not (Test-Path -LiteralPath $loc -ErrorAction SilentlyContinue)) {
        [void]$findings.Add([pscustomobject]@{ key=(ToReg $_.PSPath); name=$p.DisplayName; type='Desinstalación huérfana'; severity='BAJA'; detail=$loc })
      }
    }
  }
}

# 2) App Paths pointing to a missing executable
$ap = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'
if (Test-Path $ap) {
  Get-ChildItem $ap -ErrorAction SilentlyContinue | ForEach-Object {
    $def = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).'(default)'
    if ($def) {
      $exe = $def.Trim('"')
      if ($exe -and -not (Test-Path -LiteralPath $exe -ErrorAction SilentlyContinue)) {
        [void]$findings.Add([pscustomobject]@{ key=(ToReg $_.PSPath); name=$_.PSChildName; type='App Path inválido'; severity='MEDIA'; detail=$exe })
      }
    }
  }
}

# 3) Run entries whose target file is gone
$runKeys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run')
foreach ($rk in $runKeys) {
  if (-not (Test-Path $rk)) { continue }
  $props = Get-ItemProperty -Path $rk -ErrorAction SilentlyContinue
  foreach ($pr in $props.PSObject.Properties) {
    if ($pr.Name -like 'PS*') { continue }
    $cmd = [string]$pr.Value
    $m = [regex]::Match($cmd, '"([^"]+\\.exe)"')
    if (-not $m.Success) { $m = [regex]::Match($cmd, '^([^\\s]+\\.exe)') }
    if ($m.Success) {
      $exe = $m.Groups[1].Value
      if (-not (Test-Path -LiteralPath $exe -ErrorAction SilentlyContinue)) {
        [void]$findings.Add([pscustomobject]@{ key=(ToReg $rk); name=$pr.Name; type='Arranque roto'; severity='MEDIA'; detail=$exe; valueName=$pr.Name })
      }
    }
  }
}
$findings | ConvertTo-Json -Compress`;
  const r = await psJson(script, { timeout: 30000 });
  if (!r.ok) return { ok: false, error: r.error };
  const findings = asArray(r.data);
  // Whitelist: clean-registry solo puede tocar exactamente lo que este scan
  // encontró. Evita que un estado de renderer corrupto o desincronizado borre
  // claves arbitrarias del registro.
  lastRegistryScan = new Map(findings.map(f => [`${f.key} ${f.valueName || ''}`, f]));
  return { ok: true, data: findings };
});

ipcMain.handle('clean-registry', async (e, items) => {
  if (!IS_WIN) return { ok: false };
  if (!items || !items.length) return { ok: false, error: 'Nada seleccionado' };

  // Validador estático independiente de la whitelist: por muy en la
  // whitelist que esté, esto solo debe tocar HKLM/HKCU (nunca HKCR, HKU,
  // ni nada colado por error).
  const validKey = k => /^HK(LM|CU):?\\/i.test(k || '');
  const whitelisted = items.filter(it => validKey(it.key) && lastRegistryScan.has(`${it.key} ${it.valueName || ''}`));
  const rejected = items.length - whitelisted.length;
  if (!whitelisted.length) {
    return { ok: false, error: 'Ningún elemento coincide con el último escaneo; vuelve a escanear el registro' };
  }

  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e2) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupSub = path.join(BACKUP_DIR, `reg-${stamp}`);
  try { fs.mkdirSync(backupSub, { recursive: true }); } catch (e2) {}

  // Los datos van por stdin como JSON en vez de interpolarse en el texto del
  // script: evita depender de un escape manual de comillas para valores que
  // vienen del registro (nombres de claves, rutas) y podrían romper el
  // literal de PowerShell si tuvieran algún carácter inesperado.
  const payload = JSON.stringify(whitelisted.map((it, i) => ({
    key: it.key || '',
    value: it.valueName || null,
    file: path.join(backupSub, `item-${i}.reg`),
  })));

  const script = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$items = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
$done = 0; $errs = @()
foreach ($it in $items) {
  $regPath = $it.key
  $backupOk = $false
  try {
    reg export "$regPath" "$($it.file)" /y *> $null
    if ((Test-Path -LiteralPath $it.file) -and (Get-Item -LiteralPath $it.file).Length -gt 0) { $backupOk = $true }
  } catch {}
  if (-not $backupOk) { $errs += "Backup falló para $regPath, se omite el borrado"; continue }
  try {
    $psp = $regPath -replace '^HKLM','HKLM:' -replace '^HKCU','HKCU:'
    if ($it.value) {
      Remove-ItemProperty -Path $psp -Name $it.value -Force -ErrorAction Stop
    } else {
      Remove-Item -Path $psp -Recurse -Force -ErrorAction Stop
    }
    $done++
  } catch { $errs += $_.Exception.Message }
}
[pscustomobject]@{ done=$done; total=$items.Count; errors=$errs } | ConvertTo-Json -Compress`;
  const r = await psJson(script, { timeout: 30000, input: payload });
  // Las claves procesadas ya no son válidas para un segundo intento sin re-escanear,
  // tanto si PowerShell falló como si tuvo éxito parcial.
  whitelisted.forEach(it => lastRegistryScan.delete(`${it.key} ${it.valueName || ''}`));
  if (!r.ok) {
    addHistory('Registro', 'Falló la limpieza: ' + r.error, { status: 'ERROR' });
    return { ok: false, error: r.error, done: 0, total: items.length, backup: backupSub };
  }
  const done = (r.data && r.data.done) || 0;
  addHistory('Registro', `${done} entradas eliminadas (backup en ${path.basename(backupSub)})`, { status: done > 0 ? 'OK' : 'WARN' });
  return {
    ok: done > 0,
    done,
    total: items.length,
    backup: backupSub,
    error: done === 0 ? (isAdmin ? 'No se pudo eliminar (backup falló o acceso denegado)' : 'Requiere administrador') : (rejected > 0 ? `${rejected} elementos ignorados (no coinciden con el último escaneo)` : null),
  };
});

/* ═══════════════════════════════════════════════════════════════════
   SYSTEM RESTORE POINT + DEEP REPAIR (SFC / DISM) with streamed log
   ═══════════════════════════════════════════════════════════════════ */
ipcMain.handle('create-restore-point', async () => {
  if (!IS_WIN) return { ok: false };
  const r = await ps(`
try {
  Enable-ComputerRestore -Drive "$env:SystemDrive\\" -ErrorAction SilentlyContinue
  $rp = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore'
  if (-not (Test-Path $rp)) { New-Item -Path $rp -Force | Out-Null }
  Set-ItemProperty -Path $rp -Name 'SystemRestorePointCreationFrequency' -Value 0 -Type DWord -ErrorAction SilentlyContinue
  Checkpoint-Computer -Description 'Vokoptimizer' -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
  Write-Output 'OK'
} catch { Write-Output ('ERR:' + $_.Exception.Message) }`, { timeout: 90000 });
  const ok = /^OK/.test(r.stdout);
  if (ok) addHistory('Punto de restauración', 'creado');
  return { ok, error: ok ? null : ((r.stdout || '').replace(/^ERR:/, '') || (isAdmin ? 'Protección del sistema desactivada' : 'Requiere administrador')) };
});

let healthRunning = false;
let healthChild = null;
let healthCancelled = false;
ipcMain.handle('run-health', async (e, kind) => {
  if (!IS_WIN || healthRunning) return { ok: false, error: healthRunning ? 'Ya en ejecución' : 'No disponible' };
  healthRunning = true;
  healthCancelled = false;
  const send = (line) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('health-log', line); };
  const t0 = Date.now();

  const runOne = (file, args, label) => new Promise(resolve => {
    send(`\n> ${label}\n`);
    let child;
    try { child = spawn(file, args, { windowsHide: true }); }
    catch (err) { send(`  [ERROR] ${err.message}\n`); resolve(false); return; }
    healthChild = child;
    const onData = buf => {
      const txt = buf.toString('utf8').replace(/ /g, '').replace(/\r/g, '');
      txt.split('\n').forEach(l => { const t = l.trim(); if (t) send('  ' + t + '\n'); });
    };
    child.stdout && child.stdout.on('data', onData);
    child.stderr && child.stderr.on('data', onData);
    child.on('error', err => { send(`  [ERROR] ${err.message}\n`); resolve(false); });
    child.on('close', code => {
      healthChild = null;
      send(healthCancelled ? '  [cancelado]\n' : `  [exit ${code}]\n`);
      resolve(code === 0);
    });
  });

  (async () => {
    let ok = true;
    if (kind === 'dism' || kind === 'all') ok = await runOne('dism.exe', ['/Online', '/Cleanup-Image', '/RestoreHealth'], 'DISM /RestoreHealth') && ok;
    if (!healthCancelled && (kind === 'sfc' || kind === 'all')) ok = await runOne('sfc.exe', ['/scannow'], 'SFC /scannow') && ok;
    send(healthCancelled ? '\n> CANCELADO por el usuario\n' : `\n> COMPLETADO en ${Math.round((Date.now() - t0) / 1000)}s\n`);
    addHistory('Reparación del sistema', kind.toUpperCase(), { status: healthCancelled ? 'WARN' : (ok ? 'OK' : 'WARN'), durationMs: Date.now() - t0 });
    healthRunning = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('health-done', { ok: ok && !healthCancelled, cancelled: healthCancelled });
  })();

  return { ok: true, started: true };
});

ipcMain.handle('cancel-health', async () => {
  if (!healthRunning || !healthChild) return { ok: false, error: 'No hay ninguna reparación en curso' };
  healthCancelled = true;
  // SFC/DISM no responden a una señal normal; taskkill /T corta también los
  // hijos que lanzan internamente (p.ej. TrustedInstaller para DISM).
  try { await execAsync('taskkill /PID ' + healthChild.pid + ' /T /F'); } catch (e) {}
  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════
   ONE-CLICK OPTIMIZE  (safe bundle)
   ═══════════════════════════════════════════════════════════════════ */
ipcMain.handle('optimize-cpu-ram', async () => {
  if (!IS_WIN) return { ok: false };
  const before = await memAvailable();
  await ps(`
$sig = @"
using System;
using System.Runtime.InteropServices;
public class VokMem2 { [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr hProcess); }
"@
try { Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue } catch {}
Get-Process -ErrorAction SilentlyContinue | ForEach-Object { try { [void][VokMem2]::EmptyWorkingSet($_.Handle) } catch {} }
[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()
ipconfig /flushdns | Out-Null`, { timeout: 30000 });
  await new Promise(r => setTimeout(r, 500));
  const after = await memAvailable();
  return { ok: true, freed: Math.max(0, after - before) };
});

/* ═══════════════════════════════════════════════════════════════════
   APPS SIN USAR — cruza Prefetch (última ejecución real) con el registro
   de aplicaciones instaladas. Nada se borra aquí: solo se informa y se
   ofrece abrir la carpeta o lanzar el desinstalador oficial.
   ═══════════════════════════════════════════════════════════════════ */
ipcMain.handle('scan-unused-apps', async () => {
  if (!IS_WIN) return { ok: false, error: 'No disponible' };
  const script = `
$prefetch = @{}
try {
  Get-ChildItem -Path "$env:SystemRoot\\Prefetch\\*.pf" -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $base = ($_.BaseName -split '-')[0].ToLowerInvariant()
    if (-not $prefetch.ContainsKey($base) -or $_.LastWriteTime -gt $prefetch[$base]) { $prefetch[$base] = $_.LastWriteTime }
  }
} catch {}
$prefetchCount = $prefetch.Count

$apps = New-Object System.Collections.ArrayList
$roots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName) { return }
    if ($p.SystemComponent -eq 1) { return }
    if ($p.ParentKeyName) { return }
    $loc = [string]$p.InstallLocation
    $lastUsed = $null; $approx = $true; $matched = $false
    if ($loc -and (Test-Path -LiteralPath $loc -ErrorAction SilentlyContinue)) {
      try {
        $exes = Get-ChildItem -LiteralPath $loc -Recurse -Depth 3 -Filter *.exe -Force -ErrorAction SilentlyContinue
        foreach ($ex in $exes) {
          $b = $ex.BaseName.ToLowerInvariant()
          if ($prefetch.ContainsKey($b)) {
            $d = $prefetch[$b]
            if ((-not $lastUsed) -or ($d -gt $lastUsed)) { $lastUsed = $d; $matched = $true }
          }
        }
      } catch {}
      if (-not $matched) {
        try { $lastUsed = (Get-Item -LiteralPath $loc -ErrorAction SilentlyContinue).LastWriteTime; $approx = $true } catch {}
      } else {
        $approx = $false
      }
    }
    [void]$apps.Add([pscustomobject]@{
      name = $p.DisplayName
      publisher = [string]$p.Publisher
      installLocation = $loc
      sizeKB = if ($p.EstimatedSize) { [int64]$p.EstimatedSize } else { 0 }
      lastUsed = if ($lastUsed) { $lastUsed.ToString('o') } else { $null }
      approximate = $approx
      uninstallString = [string]$p.UninstallString
      quietUninstallString = [string]$p.QuietUninstallString
    })
  }
}
[pscustomobject]@{ apps = $apps; prefetchCount = $prefetchCount } | ConvertTo-Json -Compress -Depth 6`;
  const r = await psJson(script, { timeout: 45000, name: 'unused-apps' });
  if (!r.ok) return { ok: false, error: r.kind === 'timeout' ? 'El escaneo tardó demasiado (cancelado)' : r.error };
  const data = r.data || {};
  const apps = asArray(data.apps).map(a => ({
    name: a.name,
    publisher: a.publisher || '',
    installLocation: a.installLocation || '',
    sizeBytes: (a.sizeKB || 0) * 1024,
    lastUsed: a.lastUsed || null,
    approximate: !!a.approximate,
    hasUsageData: !!a.lastUsed,
    uninstallString: a.uninstallString || '',
    quietUninstallString: a.quietUninstallString || '',
  })).sort((x, y) => {
    // Sin datos al final; entre las que sí tienen fecha, la más antigua primero
    // (es la que más interesa revisar).
    if (!x.lastUsed && !y.lastUsed) return 0;
    if (!x.lastUsed) return 1;
    if (!y.lastUsed) return -1;
    return new Date(x.lastUsed) - new Date(y.lastUsed);
  });

  // Aviso cruzado: si se limpiaron archivos temporales (Prefetch entre ellos)
  // hace poco, los datos de "último uso" de esta lista pueden estar incompletos.
  const hist = loadHistory();
  const recentClean = hist.find(h => h.op === 'Limpieza de archivos' && (Date.now() - h.ts) < 24 * 3600 * 1000);
  const warning = recentClean
    ? 'Se limpiaron archivos temporales hace menos de 24h. Si "Prefetch de Windows" estaba entre las categorías, el "último uso" de algunas apps puede estar incompleto o ser una aproximación.'
    : null;

  return { ok: true, data: { apps, prefetchCount: data.prefetchCount || 0, warning } };
});

ipcMain.handle('open-app-folder', async (e, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') return { ok: false, error: 'Ruta inválida' };
  try {
    const err = await shell.openPath(folderPath);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('uninstall-app', async (e, appInfo) => {
  if (!IS_WIN || !appInfo) return { ok: false };
  const cmd = appInfo.quietUninstallString || appInfo.uninstallString;
  if (!cmd) return { ok: false, error: 'Este programa no tiene desinstalador registrado' };
  // Se lanza el desinstalador oficial tal cual lo registró el instalador —
  // nunca borramos la carpeta nosotros. No se espera a que termine: muchos
  // desinstaladores son interactivos (piden confirmación al usuario).
  try {
    exec(cmd, { windowsHide: false }, () => {});
    addHistory('Desinstalación', appInfo.name || cmd);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

/* ═══════════════════════════════════════════════════════════════════
   RESTOS DE CONFIGURACIÓN — carpetas huérfanas en AppData/ProgramData
   que ya no pertenecen a ninguna app instalada, proceso en ejecución ni
   acceso directo del Menú Inicio. Ver diseño acordado (grill-me):
     - matching por tokens completos normalizados, con fallback de
       concatenación para nombres de carpeta pegados sin separadores
       (discordcanary, spotifywebhelper...)
     - fuentes de referencia: registro Uninstall + procesos en ejecución
       + accesos directos del Menú Inicio
     - allowlist fija de herramientas sin entrada de registro
     - confianza alta = sin ningún match Y 180+ días sin tocarse;
       baja = pasa el filtro base (90+ días, >100KB, no allowlist) pero
       no llega a los 180 días. El "sin match" ya es requisito para ser
       candidato en absoluto — lo único que separa alta/baja a partir de
       ahí es la antigüedad.
   ═══════════════════════════════════════════════════════════════════ */
// Carpetas técnicas de Windows/Electron y herramientas de desarrollo que
// habitualmente no tienen una entrada de Uninstall 1:1 con su nombre de
// carpeta, pero que NO son restos de una desinstalación — son estado
// activo de algo que sigue en uso (gestores de paquetes, runtimes,
// carpetas propias del sistema operativo).
const REMNANT_ALLOWLIST = [
  // Sistema / OS
  'microsoft', 'packages', 'package cache', 'temp', 'crashdumps', 'd3dscache',
  'elevateddiagnostics', 'comms', 'connecteddevicesplatform', 'identitycache',
  'windows', 'systemappdata', 'programdata', 'nvidia corporation', 'nvidia',
  'intel', 'amd', 'realtek', 'appdata',
  // Gestores de paquetes / runtimes / herramientas de desarrollo sin registro
  'npm', 'npm-cache', 'node-gyp', 'pip', 'pypoetry', 'nuget', 'cargo',
  'go-build', 'nvm', 'pyenv-win', 'yarn', 'composer', 'chocolatey', 'scoop',
  'ssh', 'gnupg', 'gh', 'git', 'pnpm', 'pnpm-cache', 'deno', 'bun',
];

ipcMain.handle('scan-config-remnants', async () => {
  if (!IS_WIN) return { ok: false, error: 'No disponible' };
  const allowlistPs = REMNANT_ALLOWLIST.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
  const script = `
$noise = @('inc','llc','gmbh','corp','ltd','the','app','application','launcher','client','software','technologies','technology','studio','studios','games','game','desktop','win','win64','win32','x64','x86')
$allowlist = @(${allowlistPs})

function Get-Tokens($name) {
  if (-not $name) { return @() }
  $lower = $name.ToLowerInvariant()
  return @([regex]::Split($lower, '[^a-z0-9]+') | Where-Object { $_.Length -ge 3 -and ($noise -notcontains $_) })
}
function Get-Concat($name) {
  if (-not $name) { return '' }
  return ([regex]::Replace($name.ToLowerInvariant(), '[^a-z0-9]', ''))
}
function Test-Match($folderTokens, $folderConcat, $refTokens) {
  if ($refTokens.Count -eq 0) { return $false }
  if ($folderTokens.Count -gt 0) {
    $allFolderInRef = (@($folderTokens | Where-Object { $refTokens -notcontains $_ })).Count -eq 0
    $allRefInFolder = (@($refTokens | Where-Object { $folderTokens -notcontains $_ })).Count -eq 0
    if ($allFolderInRef -or $allRefInFolder) { return $true }
  }
  if ($folderTokens.Count -eq 1 -and $folderConcat) {
    $concatRef = ($refTokens -join '')
    if ($concatRef -and $folderConcat.Contains($concatRef)) { return $true }
  }
  return $false
}

# --- Construir el conjunto de referencia (apps instaladas + procesos + accesos directos) ---
$refNames = New-Object System.Collections.Generic.List[string]
$uninstallRoots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p.DisplayName) { $refNames.Add([string]$p.DisplayName) }
  }
}
try { Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName -Unique | ForEach-Object { $refNames.Add([string]$_) } } catch {}
$shortcutDirs = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
foreach ($sd in $shortcutDirs) {
  if (-not (Test-Path $sd)) { continue }
  try { Get-ChildItem -LiteralPath $sd -Recurse -Filter *.lnk -Force -ErrorAction SilentlyContinue | ForEach-Object { $refNames.Add($_.BaseName) } } catch {}
}
$refs = @($refNames | Select-Object -Unique | ForEach-Object { , (Get-Tokens $_) } | Where-Object { $_.Count -gt 0 })

# --- Escanear carpetas candidatas ---
$cutoff90 = (Get-Date).AddDays(-90)
$cutoff180 = (Get-Date).AddDays(-180)
$roots = @(
  @{ path = $env:APPDATA; label = 'Roaming' },
  @{ path = $env:LOCALAPPDATA; label = 'Local' },
  @{ path = "$env:ProgramData"; label = 'ProgramData' }
)
$out = New-Object System.Collections.ArrayList
foreach ($r in $roots) {
  if (-not (Test-Path $r.path)) { continue }
  Get-ChildItem -LiteralPath $r.path -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $folder = $_
    $nameLower = $folder.Name.ToLowerInvariant()
    if ($allowlist -contains $nameLower) { return }
    $fTokens = Get-Tokens $folder.Name
    $fConcat = Get-Concat $folder.Name
    $matched = $false
    foreach ($refTokens in $refs) {
      if (Test-Match $fTokens $fConcat $refTokens) { $matched = $true; break }
    }
    if ($matched) { return }
    # Solo se paga el coste de recorrer el contenido si ya pasó el filtro barato de arriba.
    $size = [int64]0; $maxDate = $folder.LastWriteTime
    try {
      Get-ChildItem -LiteralPath $folder.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $size += [int64]$_.Length
        if ($_.LastWriteTime -gt $maxDate) { $maxDate = $_.LastWriteTime }
      }
    } catch {}
    if ($size -lt 102400) { return }
    if ($maxDate -gt $cutoff90) { return }
    $confidence = if ($maxDate -lt $cutoff180) { 'alta' } else { 'baja' }
    [void]$out.Add([pscustomobject]@{
      path = $folder.FullName
      root = $r.label
      name = $folder.Name
      sizeBytes = $size
      lastModified = $maxDate.ToString('o')
      confidence = $confidence
    })
  }
}
$out | ConvertTo-Json -Compress -Depth 4`;
  const r = await psJson(script, { timeout: 90000, name: 'config-remnants' });
  if (!r.ok) return { ok: false, error: r.kind === 'timeout' ? 'El escaneo tardó demasiado (cancelado)' : r.error };
  const remnants = asArray(r.data).sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  return { ok: true, data: remnants };
});

/* ═══════════════════════════════════════════════════════════════════
   CUARENTENA — nada se borra de entrada. Un resto "eliminado" se mueve a
   %APPDATA%\vokoptimizer\quarantine\<id> con manifiesto, y desde ahí se
   puede restaurar a su ruta exacta original o purgar (con confirmación
   explícita del lado de la UI).
   ═══════════════════════════════════════════════════════════════════ */
const QUARANTINE_DIR = path.join(app.getPath('userData'), 'quarantine');
const QUARANTINE_MANIFEST_FILE = path.join(app.getPath('userData'), 'quarantine-manifest.json');

function loadQuarantineManifest() {
  try { return JSON.parse(fs.readFileSync(QUARANTINE_MANIFEST_FILE, 'utf8')); } catch (e) { return []; }
}
function saveQuarantineManifest(list) {
  try { fs.writeFileSync(QUARANTINE_MANIFEST_FILE, JSON.stringify(list, null, 2)); } catch (e) {}
}

const SYSTEM_ROOTS = [
  (process.env.SystemDrive || 'C:') + '\\',
  process.env.SystemRoot,
  path.join(process.env.SystemDrive || 'C:\\', 'Program Files'),
  path.join(process.env.SystemDrive || 'C:\\', 'Program Files (x86)'),
  path.join(process.env.SystemDrive || 'C:\\', 'Users'),
  process.env.APPDATA,
  process.env.LOCALAPPDATA,
  process.env.ProgramData,
].filter(Boolean).map(p => path.resolve(p).toLowerCase());

// C:\ProgramData\<algo> ya está a profundidad 3 y es una de las tres raíces
// que escanea el Módulo 1b — un mínimo de 4 la habría rechazado siempre.
// 3 sigue bloqueando cualquier raíz de sistema o su hijo directo
// (C:\Users, C:\ProgramData, C:\Windows... todos profundidad ≤2).
const QUARANTINE_MIN_DEPTH = 3;

let cachedFixedDrives = null;
async function getLocalFixedDrives() {
  if (cachedFixedDrives) return cachedFixedDrives;
  // DriveType=3 en Win32_LogicalDisk = disco local fijo (excluye red=4 y
  // extraíbles=2). Se cachea porque las letras de unidad no cambian en
  // mitad de una sesión de la app.
  const r = await ps('(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue).DeviceID -join \',\'', { timeout: 8000 });
  cachedFixedDrives = new Set((r.stdout || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
  return cachedFixedDrives;
}

async function assertSafeToQuarantine(originalPath) {
  if (!originalPath || typeof originalPath !== 'string') return { ok: false, error: 'Ruta inválida' };
  if (/^\\\\/.test(originalPath)) return { ok: false, error: 'No se permite mover rutas de red (UNC)' };

  let real;
  try { real = fs.realpathSync(originalPath); }
  catch (e) { return { ok: false, error: 'No se pudo resolver la ruta real (¿ya no existe?)' }; }
  const resolved = path.resolve(real);
  const resolvedLower = resolved.toLowerCase();

  if (SYSTEM_ROOTS.includes(resolvedLower)) return { ok: false, error: 'Esa ruta es una raíz protegida del sistema' };

  const depth = resolved.split(path.sep).filter(Boolean).length;
  if (depth < QUARANTINE_MIN_DEPTH) return { ok: false, error: 'La ruta es demasiado superficial para ser un resto seguro de mover' };

  let stat;
  try { stat = fs.statSync(resolved); } catch (e) { return { ok: false, error: 'La ruta ya no existe' }; }
  if (!stat.isDirectory()) return { ok: false, error: 'Solo se pueden poner en cuarentena carpetas' };

  const oneDriveRoots = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer]
    .filter(Boolean).map(p => path.resolve(p).toLowerCase());
  if (oneDriveRoots.some(r => resolvedLower === r || resolvedLower.startsWith(r + path.sep))) {
    return { ok: false, error: 'Esa carpeta está dentro de OneDrive (sincronizada) — no se mueve automáticamente' };
  }

  const drive = path.parse(resolved).root.replace(/\\$/, '').toUpperCase();
  const fixedDrives = await getLocalFixedDrives();
  if (fixedDrives.size && !fixedDrives.has(drive)) {
    return { ok: false, error: 'Esa unidad no es un disco local fijo (¿red o extraíble?)' };
  }

  return { ok: true, resolved };
}

// robocopy usa códigos de salida por bits donde 0-7 son variantes de
// "éxito" — en vez de fiarse del exit code, se comprueba directamente si
// el destino quedó creado tras el /MOVE.
function robocopyMove(src, dst, timeout = 90000) {
  const s = src.replace(/'/g, "''");
  const d = dst.replace(/'/g, "''");
  return ps(`
try {
  robocopy '${s}' '${d}' /MOVE /E /R:1 /W:1 /NFL /NDL /NJH /NJS *> $null
  if (Test-Path -LiteralPath '${d}') { Write-Output 'OK' } else { Write-Output 'ERR:robocopy no completó el movimiento' }
} catch { Write-Output ('ERR:' + $_.Exception.Message) }`, { timeout });
}

ipcMain.handle('quarantine-remnant', async (e, item) => {
  if (!IS_WIN || !item || !item.path) return { ok: false, error: 'Datos inválidos' };
  const guard = await assertSafeToQuarantine(item.path);
  if (!guard.ok) return guard;
  const original = guard.resolved;

  try { fs.mkdirSync(QUARANTINE_DIR, { recursive: true }); } catch (e2) {}
  const id = crypto.randomBytes(8).toString('hex');
  const dest = path.join(QUARANTINE_DIR, id);

  let moved = false, moveError = null;
  try { fs.renameSync(original, dest); moved = true; }
  catch (err) {
    // Cruza de volumen o archivo en uso: fs.renameSync falla con EXDEV/EBUSY.
    const r = await robocopyMove(original, dest);
    moved = /^OK/.test(r.stdout);
    moveError = moved ? null : (r.stdout || '').replace(/^ERR:/, '');
  }
  if (!moved) return { ok: false, error: moveError || 'No se pudo mover la carpeta' };

  const manifest = loadQuarantineManifest();
  manifest.unshift({
    id, originalPath: original, label: item.name || path.basename(original),
    sizeBytes: item.sizeBytes || 0, quarantinedAt: Date.now(),
  });
  saveQuarantineManifest(manifest);
  addHistory('Cuarentena', `${item.name || path.basename(original)} movido a cuarentena`);
  return { ok: true, id };
});

ipcMain.handle('list-quarantine', async () => ({ ok: true, data: loadQuarantineManifest() }));

ipcMain.handle('restore-remnant', async (e, id) => {
  if (!id) return { ok: false, error: 'ID inválido' };
  const manifest = loadQuarantineManifest();
  const entry = manifest.find(m => m.id === id);
  if (!entry) return { ok: false, error: 'No se encontró esa entrada en cuarentena' };
  const src = path.join(QUARANTINE_DIR, id);
  if (!fs.existsSync(src)) return { ok: false, error: 'El contenido en cuarentena ya no existe' };
  if (fs.existsSync(entry.originalPath)) {
    return { ok: false, error: 'Ya existe algo en la ruta original — no se sobrescribe. Revísalo manualmente.' };
  }

  try { fs.mkdirSync(path.dirname(entry.originalPath), { recursive: true }); } catch (e2) {}
  let moved = false, moveError = null;
  try { fs.renameSync(src, entry.originalPath); moved = true; }
  catch (err) {
    const r = await robocopyMove(src, entry.originalPath);
    moved = /^OK/.test(r.stdout);
    moveError = moved ? null : (r.stdout || '').replace(/^ERR:/, '');
  }
  if (!moved) return { ok: false, error: moveError || 'No se pudo restaurar' };

  saveQuarantineManifest(manifest.filter(m => m.id !== id));
  addHistory('Cuarentena', `${entry.label} restaurado a su ruta original`);
  return { ok: true };
});

ipcMain.handle('purge-remnant', async (e, id) => {
  if (!id) return { ok: false, error: 'ID inválido' };
  const manifest = loadQuarantineManifest();
  const entry = manifest.find(m => m.id === id);
  if (!entry) return { ok: false, error: 'No se encontró esa entrada en cuarentena' };
  const target = path.join(QUARANTINE_DIR, id);
  try { fs.rmSync(target, { recursive: true, force: true }); }
  catch (err) { return { ok: false, error: 'No se pudo purgar: ' + err.message }; }

  saveQuarantineManifest(manifest.filter(m => m.id !== id));
  addHistory('Cuarentena', `${entry.label} purgado permanentemente`, { status: 'WARN' });
  return { ok: true };
});

/* ═══════════════════════════════════════════════════════════════════
   DETECCIÓN DE JUEGOS — Steam (libraryfolders.vdf + appmanifest_*.acf),
   Epic (Manifests/*.item), Xbox (XboxGames), Riot, y el resto vía
   Uninstall filtrado por palabras clave de títulos conocidos.
   ═══════════════════════════════════════════════════════════════════ */
function normalizeGameName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

ipcMain.handle('scan-games', async () => {
  if (!IS_WIN) return { ok: false, error: 'No disponible' };
  const script = `
$games = New-Object System.Collections.ArrayList

# --- Steam: SteamPath -> libraryfolders.vdf -> appmanifest_*.acf por biblioteca ---
try {
  $steamPath = (Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -Name SteamPath -ErrorAction SilentlyContinue).SteamPath
  if ($steamPath -and (Test-Path -LiteralPath $steamPath)) {
    $libs = New-Object System.Collections.Generic.List[string]
    $libs.Add($steamPath)
    $vdf = Join-Path $steamPath 'steamapps\\libraryfolders.vdf'
    if (Test-Path -LiteralPath $vdf) {
      $content = Get-Content -LiteralPath $vdf -Raw -ErrorAction SilentlyContinue
      if ($content) {
        [regex]::Matches($content, '"path"\\s*"([^"]+)"') | ForEach-Object {
          $p = $_.Groups[1].Value -replace '\\\\\\\\', '\\'
          if ($p -and (Test-Path -LiteralPath $p) -and (-not $libs.Contains($p))) { $libs.Add($p) }
        }
      }
    }
    foreach ($lib in $libs) {
      $appsDir = Join-Path $lib 'steamapps'
      if (-not (Test-Path -LiteralPath $appsDir)) { continue }
      Get-ChildItem -LiteralPath $appsDir -Filter 'appmanifest_*.acf' -ErrorAction SilentlyContinue | ForEach-Object {
        $c = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue
        if (-not $c) { return }
        $name = [regex]::Match($c, '"name"\\s*"([^"]+)"').Groups[1].Value
        $installdir = [regex]::Match($c, '"installdir"\\s*"([^"]+)"').Groups[1].Value
        if (-not $name -or -not $installdir) { return }
        $loc = Join-Path $appsDir "common\\$installdir"
        [void]$games.Add([pscustomobject]@{ name = $name; installLocation = $loc; source = 'Steam' })
      }
    }
  }
} catch {}

# --- Epic Games ---
try {
  $epicDir = "$env:ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests"
  if (Test-Path -LiteralPath $epicDir) {
    Get-ChildItem -LiteralPath $epicDir -Filter '*.item' -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $j = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($j -and $j.DisplayName -and $j.InstallLocation) {
          [void]$games.Add([pscustomobject]@{ name = $j.DisplayName; installLocation = $j.InstallLocation; source = 'Epic'; launchExe = [string]$j.LaunchExecutable })
        }
      } catch {}
    }
  }
} catch {}

# --- Xbox / Game Pass: carpeta XboxGames en cada disco fijo ---
try {
  Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction SilentlyContinue | ForEach-Object {
    $xb = Join-Path ($_.DeviceID + '\\') 'XboxGames'
    if (Test-Path -LiteralPath $xb) {
      Get-ChildItem -LiteralPath $xb -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        [void]$games.Add([pscustomobject]@{ name = $_.Name; installLocation = $_.FullName; source = 'Xbox' })
      }
    }
  }
} catch {}

# --- Riot Games ---
try {
  $riotRoots = @('C:\\Riot Games')
  foreach ($rr in $riotRoots) {
    if (Test-Path -LiteralPath $rr) {
      Get-ChildItem -LiteralPath $rr -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'Riot Client' } | ForEach-Object {
        [void]$games.Add([pscustomobject]@{ name = $_.Name; installLocation = $_.FullName; source = 'Riot' })
      }
    }
  }
} catch {}

# --- Resto (Battle.net, EA, Ubisoft, GOG...) vía Uninstall filtrado por palabra clave ---
$keywords = @('battle.net','world of warcraft','overwatch','diablo','hearthstone','starcraft',
  'ea app','origin','ubisoft','uplay','gog galaxy','the sims','need for speed',
  'fortnite','counter-strike','valorant','apex legends','league of legends',
  'call of duty','warzone','modern warfare','black ops','grand theft auto',
  'red dead redemption','cyberpunk','minecraft','rocket league')
$uninstallRoots = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $p.DisplayName) { return }
    $lower = $p.DisplayName.ToLowerInvariant()
    $isGame = $false
    foreach ($kw in $keywords) { if ($lower.Contains($kw)) { $isGame = $true; break } }
    if (-not $isGame -or -not $p.InstallLocation) { return }
    [void]$games.Add([pscustomobject]@{ name = $p.DisplayName; installLocation = [string]$p.InstallLocation; source = 'Registro' })
  }
}

# --- Localizar el .exe principal de cada juego ---
function Find-MainExe($dir) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { return $null }
  try {
    $candidates = Get-ChildItem -LiteralPath $dir -Recurse -Depth 3 -Filter *.exe -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notmatch '(?i)^unins|^crash|^setup|redist|vcredist' }
    if (-not $candidates) { return $null }
    return ($candidates | Sort-Object Length -Descending | Select-Object -First 1).FullName
  } catch { return $null }
}
foreach ($g in $games) {
  $exe = $null
  if ($g.source -eq 'Epic' -and $g.launchExe) {
    $cand = Join-Path $g.installLocation $g.launchExe
    if (Test-Path -LiteralPath $cand) { $exe = $cand }
  }
  if (-not $exe) { $exe = Find-MainExe $g.installLocation }
  $g | Add-Member -NotePropertyName exePath -NotePropertyValue $exe -Force
}
$games | ConvertTo-Json -Compress -Depth 5`;
  const r = await psJson(script, { timeout: 90000, name: 'games' });
  if (!r.ok) return { ok: false, error: r.kind === 'timeout' ? 'El escaneo tardó demasiado (cancelado)' : r.error };

  // Deduplicar por nombre normalizado: el mismo juego puede aparecer por
  // Steam y de nuevo por el barrido de Uninstall (p.ej. si también tiene
  // un acceso directo genérico registrado).
  const byName = new Map();
  asArray(r.data).forEach(g => {
    if (!g.name || !g.installLocation) return;
    const key = normalizeGameName(g.name);
    if (!key) return;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { name: g.name, installLocation: g.installLocation, exePath: g.exePath || null, sources: [g.source] });
    } else {
      if (!existing.exePath && g.exePath) existing.exePath = g.exePath;
      if (!existing.sources.includes(g.source)) existing.sources.push(g.source);
    }
  });
  const games = Array.from(byName.entries()).map(([id, g]) => ({
    id,
    name: g.name,
    installLocation: g.installLocation,
    exePath: g.exePath,
    hasExe: !!g.exePath,
    sources: g.sources,
    preset: matchGamePreset(g.name),
  })).sort((a, b) => a.name.localeCompare(b.name, 'es'));

  return { ok: true, data: games };
});

/* ═══════════════════════════════════════════════════════════════════
   PERFILES DE JUEGO — presets por título + categorías genéricas.
   ═══════════════════════════════════════════════════════════════════ */
// Aliases en minúsculas: substrings a buscar en el nombre detectado. El
// primero que matchea gana. Todo lo que no matchea cae en 'aaa' por
// defecto y el usuario puede cambiarlo a mano desde la UI.
const GAME_PRESETS = [
  { id: 'fortnite', label: 'Fortnite', aliases: ['fortnite'], category: 'competitivo' },
  { id: 'cs2', label: 'Counter-Strike 2', aliases: ['counter-strike 2', 'counter-strike global offensive', 'cs2', 'csgo'], category: 'competitivo' },
  { id: 'valorant', label: 'Valorant', aliases: ['valorant'], category: 'competitivo' },
  { id: 'apex', label: 'Apex Legends', aliases: ['apex legends'], category: 'competitivo' },
  { id: 'lol', label: 'League of Legends', aliases: ['league of legends'], category: 'competitivo' },
  { id: 'cod', label: 'Call of Duty', aliases: ['call of duty', 'warzone', 'modern warfare', 'black ops'], category: 'competitivo' },
  { id: 'rocketleague', label: 'Rocket League', aliases: ['rocket league'], category: 'competitivo' },
  { id: 'diablo4', label: 'Diablo IV', aliases: ['diablo iv', 'diablo 4'], category: 'aaa' },
  { id: 'gta5', label: 'Grand Theft Auto V', aliases: ['grand theft auto v', 'grand theft auto 5'], category: 'aaa' },
  { id: 'rdr2', label: 'Red Dead Redemption 2', aliases: ['red dead redemption 2'], category: 'aaa' },
  { id: 'cyberpunk', label: 'Cyberpunk 2077', aliases: ['cyberpunk 2077', 'cyberpunk'], category: 'aaa' },
  { id: 'minecraft', label: 'Minecraft', aliases: ['minecraft'], category: 'casual' },
];
function matchGamePreset(name) {
  const lower = (name || '').toLowerCase();
  for (const preset of GAME_PRESETS) {
    if (preset.aliases.some(a => lower.includes(a))) return { id: preset.id, label: preset.label, category: preset.category, dedicated: true };
  }
  return { id: null, label: null, category: 'aaa', dedicated: false };
}

/* ═══════════════════════════════════════════════════════════════════
   PERFILES DE JUEGO — motor de tweaks reversibles.
   Un solo perfil activo a la vez: aplicar uno nuevo revierte por completo
   el anterior primero (nunca coexisten dos conjuntos de tweaks
   compitiendo por la misma clave global de MMCSS). Antes de revertir cada
   valor se comprueba que sigue siendo el que escribimos nosotros — si
   cambió por fuera, esa clave concreta se deja intacta y se informa.
   ═══════════════════════════════════════════════════════════════════ */
const GAME_LEDGER_FILE = path.join(app.getPath('userData'), 'game-tweak-ledger.json');
function loadGameLedger() {
  try { return JSON.parse(fs.readFileSync(GAME_LEDGER_FILE, 'utf8')); } catch (e) { return { activeProfile: null, entries: [] }; }
}
function saveGameLedger(state) {
  try { fs.writeFileSync(GAME_LEDGER_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}

function buildTweakOps(category, exePath) {
  const exeName = exePath ? path.basename(exePath) : null;
  const ops = [];
  const services = [];
  let nagle = false;
  let freeRamFirst = false;

  // GPU dedicada: las tres categorías la quieren — competitivo/aaa por
  // rendimiento máximo, casual porque apps como Java (Minecraft) suelen
  // coger la GPU integrada por defecto si no se fuerza.
  if (exePath) {
    ops.push({ psPath: 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences', valueName: exePath, valueType: 'String', mode: 'set', value: 'GpuPreference=2;' });
  }

  if (category === 'competitivo') {
    if (exePath) {
      ops.push({ psPath: `HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\${exeName}\\PerfOptions`, valueName: 'CpuPriorityClass', valueType: 'DWord', mode: 'set', value: 3 });
      // append-flag: nunca pisa otros compat flags que ya tuviera el exe.
      ops.push({ psPath: 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers', valueName: exePath, mode: 'append-flag', flag: '~ DISABLEDXMAXIMIZEDWINDOWEDMODE' });
    }
    ops.push({ psPath: MMCSS, valueName: 'SystemResponsiveness', valueType: 'DWord', mode: 'set', value: 10 });
    ops.push({ psPath: MMCSS, valueName: 'NetworkThrottlingIndex', valueType: 'DWord', mode: 'set', value: 4294967295 });
    ops.push({ psPath: MMCSS_GAMES, valueName: 'GPU Priority', valueType: 'DWord', mode: 'set', value: 8 });
    ops.push({ psPath: MMCSS_GAMES, valueName: 'Priority', valueType: 'DWord', mode: 'set', value: 6 });
    ops.push({ psPath: MMCSS_GAMES, valueName: 'Scheduling Category', valueType: 'String', mode: 'set', value: 'High' });
    ops.push({ psPath: MMCSS_GAMES, valueName: 'SFIO Priority', valueType: 'String', mode: 'set', value: 'High' });
    ops.push({ psPath: 'HKCU:\\System\\GameConfigStore', valueName: 'GameDVR_Enabled', valueType: 'DWord', mode: 'set', value: 0 });
    services.push('SysMain', 'WSearch', 'DiagTrack');
    nagle = true; // solo competitivo: es lo único que pide latencia de red mínima.
  } else if (category === 'aaa') {
    if (exePath) {
      ops.push({ psPath: `HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\${exeName}\\PerfOptions`, valueName: 'CpuPriorityClass', valueType: 'DWord', mode: 'set', value: 3 });
    }
    ops.push({ psPath: MMCSS, valueName: 'SystemResponsiveness', valueType: 'DWord', mode: 'set', value: 10 });
    ops.push({ psPath: MMCSS, valueName: 'NetworkThrottlingIndex', valueType: 'DWord', mode: 'set', value: 4294967295 });
    ops.push({ psPath: MMCSS_GAMES, valueName: 'GPU Priority', valueType: 'DWord', mode: 'set', value: 8 });
    ops.push({ psPath: MMCSS_GAMES, valueName: 'Priority', valueType: 'DWord', mode: 'set', value: 6 });
    ops.push({ psPath: MMCSS_GAMES, valueName: 'Scheduling Category', valueType: 'String', mode: 'set', value: 'High' });
    ops.push({ psPath: 'HKCU:\\System\\GameConfigStore', valueName: 'GameDVR_Enabled', valueType: 'DWord', mode: 'set', value: 0 });
    services.push('SysMain', 'WSearch', 'DiagTrack');
    freeRamFirst = true; // acción de un solo uso, no se registra en el ledger (no hay nada que "revertir" de liberar RAM).
  }
  // 'casual': nada de CPU/MMCSS/servicios/Nagle — "menos agresivo con servicios".
  // Solo se queda con la GPU dedicada añadida arriba.

  return { ops, services, nagle, freeRamFirst };
}

const PS_REG_HELPERS = `
function RegRead($psPath, $name) {
  $had = $false; $val = $null; $type = $null
  if (Test-Path -LiteralPath $psPath) {
    try {
      $ik = Get-Item -LiteralPath $psPath -ErrorAction Stop
      if ($ik.GetValueNames() -contains $name) {
        $had = $true; $val = $ik.GetValue($name); $type = $ik.GetValueKind($name).ToString()
      }
    } catch {}
  }
  return @{ had = $had; value = $val; type = $type }
}
function RegWrite($psPath, $name, $type, $value) {
  if (-not (Test-Path -LiteralPath $psPath)) { New-Item -Path $psPath -Force | Out-Null }
  Set-ItemProperty -LiteralPath $psPath -Name $name -Value $value -Type $type -Force -ErrorAction Stop
}`;

async function revertActiveGameProfile() {
  const state = loadGameLedger();
  if (!state.activeProfile || !state.entries || !state.entries.length) {
    saveGameLedger({ activeProfile: null, entries: [] });
    return { ok: true, reverted: [], skipped: [], previousProfile: state.activeProfile || null };
  }
  const payload = JSON.stringify(state.entries);
  const script = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$entries = @([Console]::In.ReadToEnd() | ConvertFrom-Json)
${PS_REG_HELPERS}
$reverted = New-Object System.Collections.ArrayList
$skipped = New-Object System.Collections.ArrayList
foreach ($ent in $entries) {
  try {
    if ($ent.type -eq 'registry') {
      $now = RegRead $ent.psPath $ent.valueName
      $nowVal = if ($null -eq $now.value) { $null } else { [string]$now.value }
      $expected = if ($null -eq $ent.currentValue) { $null } else { [string]$ent.currentValue }
      $stillOurs = ($now.had -eq $true -and $nowVal -eq $expected)
      if (-not $stillOurs) {
        [void]$skipped.Add([pscustomobject]@{ label = "$($ent.psPath)\\$($ent.valueName)"; reason = 'modificado por otro programa' })
        continue
      }
      if ($ent.hadValue) {
        Set-ItemProperty -LiteralPath $ent.psPath -Name $ent.valueName -Value $ent.previousValue -Type $ent.previousType -Force -ErrorAction Stop
      } else {
        Remove-ItemProperty -LiteralPath $ent.psPath -Name $ent.valueName -Force -ErrorAction SilentlyContinue
      }
      [void]$reverted.Add([pscustomobject]@{ label = "$($ent.psPath)\\$($ent.valueName)" })
    } elseif ($ent.type -eq 'service') {
      $svc = Get-Service -Name $ent.serviceName -ErrorAction SilentlyContinue
      if ($svc -and $ent.previousState -eq 'Running' -and $svc.Status -ne 'Running') {
        Start-Service -Name $ent.serviceName -ErrorAction Stop
      }
      [void]$reverted.Add([pscustomobject]@{ label = "Servicio $($ent.serviceName)" })
    }
  } catch {
    [void]$skipped.Add([pscustomobject]@{ label = "$($ent.psPath)$($ent.valueName)"; reason = $_.Exception.Message })
  }
}
[pscustomobject]@{ reverted = $reverted; skipped = $skipped } | ConvertTo-Json -Compress -Depth 4`;
  const r = await psJson(script, { timeout: 30000, input: payload });
  const previousProfile = state.activeProfile;
  saveGameLedger({ activeProfile: null, entries: [] });
  if (!r.ok) return { ok: false, error: r.error, previousProfile };
  return { ok: true, reverted: asArray(r.data.reverted), skipped: asArray(r.data.skipped), previousProfile };
}

ipcMain.handle('apply-game-profile', async (e, game, category) => {
  if (!IS_WIN || !game) return { ok: false, error: 'Datos inválidos' };
  const revertResult = await revertActiveGameProfile();

  const { ops, services, nagle, freeRamFirst } = buildTweakOps(category, game.exePath || null);
  const payload = JSON.stringify({ ops, services, nagle, freeRamFirst });
  const script = `
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
${PS_REG_HELPERS}
$entries = New-Object System.Collections.ArrayList
$failed = New-Object System.Collections.ArrayList
if ($payload.freeRamFirst) {
  try {
    $sig = @"
using System;
using System.Runtime.InteropServices;
public class VokMemGame { [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr hProcess); }
"@
    Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
    Get-Process -ErrorAction SilentlyContinue | ForEach-Object { try { [void][VokMemGame]::EmptyWorkingSet($_.Handle) } catch {} }
  } catch {}
}
foreach ($op in $payload.ops) {
  try {
    $before = RegRead $op.psPath $op.valueName
    if ($op.mode -eq 'append-flag') {
      $existing = if ($before.had -and $before.value) { [string]$before.value } else { '' }
      $flag = [string]$op.flag
      if ($existing -and $existing.Contains($flag)) { $newVal = $existing }
      elseif ($existing) { $newVal = "$existing $flag" }
      else { $newVal = $flag }
      RegWrite $op.psPath $op.valueName 'String' $newVal
      [void]$entries.Add([pscustomobject]@{ type='registry'; psPath=$op.psPath; valueName=$op.valueName; hadValue=$before.had; previousValue=$before.value; previousType=$before.type; currentValue=$newVal })
    } else {
      RegWrite $op.psPath $op.valueName $op.valueType $op.value
      [void]$entries.Add([pscustomobject]@{ type='registry'; psPath=$op.psPath; valueName=$op.valueName; hadValue=$before.had; previousValue=$before.value; previousType=$before.type; currentValue=$op.value })
    }
  } catch {
    [void]$failed.Add([pscustomobject]@{ label = "$($op.psPath)\\$($op.valueName)"; error = $_.Exception.Message })
  }
}
foreach ($svcName in $payload.services) {
  try {
    $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
    if (-not $svc) { continue }
    if ($svc.Status -eq 'Running') {
      Stop-Service -Name $svcName -Force -ErrorAction Stop
      [void]$entries.Add([pscustomobject]@{ type='service'; serviceName=$svcName; previousState='Running' })
    }
  } catch {
    [void]$failed.Add([pscustomobject]@{ label = "Servicio $svcName"; error = $_.Exception.Message })
  }
}
if ($payload.nagle) {
  $ifaceGuids = @()
  try {
    $physical = Get-CimInstance Win32_NetworkAdapter -Filter "PhysicalAdapter=True" -ErrorAction SilentlyContinue
    $physIdx = @{}
    foreach ($pAd in $physical) { $physIdx[$pAd.Index] = $true }
    $configs = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True" -ErrorAction SilentlyContinue
    foreach ($c in $configs) { if ($physIdx.ContainsKey($c.Index) -and $c.SettingID) { $ifaceGuids += $c.SettingID } }
  } catch {}
  $ifaceGuids = @($ifaceGuids | Select-Object -Unique)
  foreach ($guid in $ifaceGuids) {
    $ifPath = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$guid"
    if (-not (Test-Path -LiteralPath $ifPath)) { continue }
    foreach ($vn in @('TcpAckFrequency','TCPNoDelay')) {
      try {
        $before = RegRead $ifPath $vn
        RegWrite $ifPath $vn 'DWord' 1
        [void]$entries.Add([pscustomobject]@{ type='registry'; psPath=$ifPath; valueName=$vn; hadValue=$before.had; previousValue=$before.value; previousType=$before.type; currentValue=1; iface=$guid })
      } catch {
        [void]$failed.Add([pscustomobject]@{ label = "Nagle $guid\\$vn"; error = $_.Exception.Message })
      }
    }
  }
}
[pscustomobject]@{ entries = $entries; failed = $failed } | ConvertTo-Json -Compress -Depth 6`;
  const r = await psJson(script, { timeout: 30000, input: payload });
  if (!r.ok) {
    return { ok: false, error: r.error, revertedPrevious: revertResult };
  }
  const entries = asArray(r.data.entries);
  const failed = asArray(r.data.failed);
  saveGameLedger({
    activeProfile: { gameId: game.id, gameName: game.name, category, exePath: game.exePath || null, appliedAt: Date.now() },
    entries,
  });
  addHistory('Perfil de juego', `${game.name} — ${category}`, { status: failed.length ? 'WARN' : 'OK' });
  return { ok: true, applied: entries.length, failed, revertedPrevious: revertResult };
});

ipcMain.handle('revert-game-profile', async () => {
  const r = await revertActiveGameProfile();
  if (r.previousProfile) addHistory('Perfil de juego', `${r.previousProfile.gameName} — optimización revertida`, { status: r.ok ? 'OK' : 'WARN' });
  return r;
});

ipcMain.handle('get-active-game-profile', async () => {
  const state = loadGameLedger();
  return { ok: true, data: state.activeProfile };
});

/* ═══════════════════════════════════════════════════════════════════
   HISTORY API
   ═══════════════════════════════════════════════════════════════════ */
ipcMain.handle('get-history', async () => loadHistory());
ipcMain.handle('clear-history', async () => { try { fs.writeFileSync(HISTORY_FILE, '[]'); } catch (e) {} return { ok: true }; });
ipcMain.handle('open-backups', async () => { try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); shell.openPath(BACKUP_DIR); } catch (e) {} return { ok: true }; });

/* ═══════════════════════════════════════════════════════════════════
   WINDOW CONTROLS
   ═══════════════════════════════════════════════════════════════════ */
ipcMain.handle('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('maximize-window', () => { if (mainWindow) { mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); } });
ipcMain.handle('close-window', () => { app.isQuiting = true; app.quit(); });

/* ═══════════════════════════════════════════════════════════════════
   WINDOW + TRAY
   ═══════════════════════════════════════════════════════════════════ */
function validBounds(b) {
  return b && typeof b.width === 'number' && typeof b.height === 'number' &&
    b.width >= 800 && b.height >= 560 && b.width <= 10000 && b.height <= 10000;
}

function createWindow() {
  const s = loadSettings();
  const saved = validBounds(s.bounds) ? s.bounds : null;
  mainWindow = new BrowserWindow({
    width: saved ? saved.width : 1180,
    height: saved ? saved.height : 760,
    x: saved && typeof saved.x === 'number' ? saved.x : undefined,
    y: saved && typeof saved.y === 'number' ? saved.y : undefined,
    minWidth: 800, minHeight: 560,
    backgroundColor: '#000000', frame: false, titleBarStyle: 'hidden',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (s.maximized) mainWindow.maximize();
  });

  Menu.setApplicationMenu(null);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  const sendMax = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('maximize-change', mainWindow.isMaximized()); };
  mainWindow.on('maximize', sendMax);
  mainWindow.on('unmaximize', sendMax);

  const persist = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    saveSettings({ bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('resize', persist);
  mainWindow.on('move', persist);
  mainWindow.on('close', persist);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  try {
    tray = new Tray(ICON_PATH);
    tray.setToolTip('Vokoptimizer · System Optimizer');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir Vokoptimizer', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Salir', click: () => { app.isQuiting = true; app.quit(); } },
    ]));
    tray.on('click', () => showWindow());
  } catch (e) {}
}

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  await checkAdmin();
  // Elevation is normally handled by the exe manifest (requireAdministrator),
  // so packaged builds arrive here already elevated. This relaunch is only a
  // safety net for packaged builds that somehow started without admin.
  if (IS_WIN && app.isPackaged && !isAdmin && !process.argv.includes('--elevated')) {
    const launched = await elevate();
    if (launched) { app.quit(); return; }
    // UAC cancelled → continue unelevated; the in-app banner lets the user retry.
  }
  createTray();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { app.isQuiting = true; });
