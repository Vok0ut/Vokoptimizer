// Catálogo cerrado de diagnósticos que el asistente IA (Ollama) puede pedir.
// Es la lista blanca completa — si un nombre no está aquí, main.js lo rechaza
// sin ejecutar nada. Todos los scripts son de solo lectura: ninguno usa /f,
// /r, /RestoreHealth, Remove-*, Stop-*, Set-*, Disable-*, etc. Si algún día
// hace falta un diagnóstico que solo se puede obtener modificando algo
// temporalmente, NO se añade aquí — que el usuario lo haga desde el módulo
// correspondiente de la app.

// Formatea con ancho fijo para que la salida sea legible tanto por el LLM
// como por el usuario si la despliega en la UI.
const FMT_TABLE = 'Format-Table -AutoSize -Wrap | Out-String -Width 200';
const FMT_LIST = 'Format-List | Out-String';

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const DIAGNOSTICS = {
  system_info: {
    description: 'SO, build, uptime, fabricante/modelo y specs básicas del equipo. Úsalo para tener contexto general del sistema.',
    maxOutputChars: 4000,
    timeout: 15000,
    script: () => `
Get-ComputerInfo -Property WindowsProductName,WindowsVersion,OsBuildNumber,OsArchitecture,CsManufacturer,CsModel,CsSystemType,CsProcessors,OsTotalVisibleMemorySize,OsLastBootUpTime | ${FMT_LIST}
    `.trim(),
  },

  recent_errors: {
    description: 'Eventos Error/Crítico de los registros System y Application de las últimas N horas (por defecto 48). Úsalo cuando el usuario mencione un fallo reciente o algo "raro" que le pasó.',
    params: { hours: { type: 'int', min: 1, max: 168, default: 48, hint: 'horas hacia atrás a revisar (1-168)' } },
    maxOutputChars: 7000,
    timeout: 20000,
    script: (p) => `
$start = (Get-Date).AddHours(-${clampInt(p.hours, 1, 168, 48)})
Get-WinEvent -FilterHashtable @{LogName='System','Application';Level=1,2;StartTime=$start} -ErrorAction SilentlyContinue |
  Select-Object -First 200 TimeCreated,LogName,Id,LevelDisplayName,ProviderName,Message |
  ${FMT_TABLE}
    `.trim(),
  },

  bsod_events: {
    description: 'Busca pantallazos azules o apagones inesperados (Kernel-Power ID 41, BugCheck ID 1001) en el registro System. Úsalo si el usuario dice que el PC se reinició solo o se congeló.',
    params: { days: { type: 'int', min: 1, max: 90, default: 30, hint: 'días hacia atrás a revisar (1-90)' } },
    maxOutputChars: 6000,
    timeout: 20000,
    script: (p) => `
$start = (Get-Date).AddDays(-${clampInt(p.days, 1, 90, 30)})
Get-WinEvent -FilterHashtable @{LogName='System';Id=1001,41;StartTime=$start} -ErrorAction SilentlyContinue |
  Select-Object -First 50 TimeCreated,Id,ProviderName,Message | ${FMT_LIST}
    `.trim(),
  },

  reliability_history: {
    description: 'Historial del Monitor de estabilidad de Windows (instalaciones, crashes, fallos) día a día. Útil para ver patrones de cuándo empezó un problema.',
    maxOutputChars: 6000,
    timeout: 15000,
    script: () => `
Get-CimInstance Win32_ReliabilityRecords -ErrorAction SilentlyContinue |
  Sort-Object TimeGenerated -Descending | Select-Object -First 100 TimeGenerated,SourceName,Message |
  ${FMT_TABLE}
    `.trim(),
  },

  running_processes: {
    description: 'Top procesos por uso de CPU y por uso de memoria en este momento.',
    maxOutputChars: 4000,
    timeout: 15000,
    script: () => `
"--- Top CPU ---"
Get-Process | Sort-Object CPU -Descending | Select-Object -First 12 Name,Id,CPU,@{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB)}} | ${FMT_TABLE}
"--- Top memoria ---"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 Name,Id,@{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB)}} | ${FMT_TABLE}
    `.trim(),
  },

  services_status: {
    description: 'Servicios configurados como automáticos que no están corriendo — señal de algo que debería estar activo y no lo está.',
    maxOutputChars: 5000,
    timeout: 15000,
    script: () => `
Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } |
  Select-Object Name,DisplayName,Status,StartType | ${FMT_TABLE}
    `.trim(),
  },

  disk_health: {
    description: 'Estado físico/SMART de los discos — detecta discos con salud degradada antes de que fallen.',
    maxOutputChars: 4000,
    timeout: 15000,
    script: () => `
"--- Discos físicos ---"
Get-PhysicalDisk | Select-Object DeviceId,FriendlyName,MediaType,HealthStatus,OperationalStatus | ${FMT_TABLE}
"--- Contadores de fiabilidad ---"
Get-StorageReliabilityCounter -ErrorAction SilentlyContinue | Select-Object DeviceId,Wear,Temperature,ReadErrorsTotal,WriteErrorsTotal | ${FMT_TABLE}
    `.trim(),
  },

  disk_scan_report: {
    description: 'chkdsk de solo lectura (sin /f ni /r) sobre una unidad — reporta errores del sistema de archivos sin corregir nada. Puede tardar hasta un minuto.',
    params: { drive: { type: 'letter', default: 'C', hint: 'letra de unidad, una sola letra, ej. C' } },
    maxOutputChars: 5000,
    timeout: 90000,
    script: (p) => `chkdsk ${p.drive}:`,
  },

  sfc_verify_only: {
    description: 'Verifica la integridad de los archivos del sistema SIN repararlos (sfc /verifyonly). Puede tardar varios minutos.',
    maxOutputChars: 5000,
    timeout: 300000,
    script: () => `sfc /verifyonly`,
  },

  dism_scan_health: {
    description: 'Detecta corrupción en la imagen de Windows (component store) SIN repararla (DISM /ScanHealth). Puede tardar varios minutos.',
    maxOutputChars: 5000,
    timeout: 300000,
    script: () => `Dism /Online /Cleanup-Image /ScanHealth`,
  },

  startup_programs: {
    description: 'Programas configurados para arrancar junto con Windows (registro y carpetas de inicio).',
    maxOutputChars: 5000,
    timeout: 15000,
    script: () => `
Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location,User | ${FMT_TABLE}
    `.trim(),
  },

  driver_issues: {
    description: 'Dispositivos con problemas en el Administrador de dispositivos (estado distinto de OK).',
    maxOutputChars: 4000,
    timeout: 15000,
    script: () => `
Get-PnpDevice | Where-Object { $_.Status -ne 'OK' } | Select-Object Class,FriendlyName,Status,ProblemCode | ${FMT_TABLE}
    `.trim(),
  },

  driver_inventory: {
    description: 'Lista de drivers instalados con versión y fecha — útil para detectar uno muy desactualizado.',
    maxOutputChars: 7000,
    timeout: 20000,
    script: () => `
Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName } |
  Select-Object DeviceName,DriverVersion,DriverDate,Manufacturer | Sort-Object DriverDate |
  Select-Object -First 150 | ${FMT_TABLE}
    `.trim(),
  },

  network_status: {
    description: 'Adaptadores de red, direcciones IP y una prueba de conectividad real (ping a 8.8.8.8).',
    maxOutputChars: 4000,
    timeout: 20000,
    script: () => `
"--- Adaptadores ---"
Get-NetAdapter | Select-Object Name,Status,LinkSpeed,MacAddress | ${FMT_TABLE}
"--- Direcciones IPv4 ---"
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object InterfaceAlias,IPAddress,PrefixLength | ${FMT_TABLE}
"--- Ping a 8.8.8.8 ---"
Test-Connection -ComputerName 8.8.8.8 -Count 4 -ErrorAction SilentlyContinue | Select-Object Address,ResponseTime | ${FMT_TABLE}
    `.trim(),
  },

  network_diagnostics: {
    description: 'Resolución DNS de prueba y conexiones TCP activas — para diagnosticar problemas de red más finos que network_status.',
    maxOutputChars: 5000,
    timeout: 20000,
    script: () => `
"--- Resolución DNS (google.com) ---"
Resolve-DnsName -Name google.com -ErrorAction SilentlyContinue | Select-Object Name,IPAddress | ${FMT_TABLE}
"--- Conexiones TCP establecidas ---"
Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Select-Object -First 40 LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess | ${FMT_TABLE}
    `.trim(),
  },

  windows_updates: {
    description: 'Parches de Windows instalados (Get-HotFix) — para saber si falta una actualización relevante.',
    maxOutputChars: 5000,
    timeout: 20000,
    script: () => `
Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 40 HotFixID,Description,InstalledOn | ${FMT_TABLE}
    `.trim(),
  },

  crash_dumps: {
    description: 'Minidumps recientes (carpeta Minidump, CrashDumps de apps) — de qué proceso y cuándo.',
    maxOutputChars: 4000,
    timeout: 15000,
    script: () => `
$paths = @("$env:WINDIR\\Minidump","$env:LOCALAPPDATA\\CrashDumps","$env:WINDIR\\LiveKernelReports")
foreach ($p in $paths) {
  if (Test-Path $p) {
    "--- $p ---"
    Get-ChildItem $p -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
      Select-Object -First 15 Name,Length,LastWriteTime | ${FMT_TABLE}
  }
}
    `.trim(),
  },

  group_policy_report: {
    description: 'Políticas de grupo aplicadas al equipo y al usuario (gpresult /r) — a veces explica por qué algo está bloqueado o restringido.',
    maxOutputChars: 6000,
    timeout: 30000,
    script: () => `gpresult /r`,
  },

  bitlocker_status: {
    description: 'Estado del cifrado BitLocker de cada volumen (solo consulta, no lo activa ni desactiva).',
    maxOutputChars: 3000,
    timeout: 15000,
    script: () => `
Get-BitLockerVolume -ErrorAction SilentlyContinue | Select-Object MountPoint,VolumeStatus,EncryptionPercentage,ProtectionStatus | ${FMT_TABLE}
    `.trim(),
  },

  // resource_usage_now se resuelve en main.js reutilizando getMetricsOnce()
  // directamente (mismo dato que el dashboard en vivo) — no lleva script PS
  // propio, pero vive en el catálogo para que el modelo pueda pedirlo.
  resource_usage_now: {
    description: 'Foto instantánea de CPU, RAM, disco y red ahora mismo (el mismo dato del dashboard en vivo).',
    maxOutputChars: 3000,
    timeout: 8000,
    special: 'metrics',
  },
};

// ─────────────────────────────────────────────────────────────────────
// ACCIONES CORRECTIVAS — catálogo cerrado, SIEMPRE con confirmación
// ─────────────────────────────────────────────────────────────────────
// A diferencia de DIAGNOSTICS, estas SÍ modifican el sistema. Por eso:
//   1. El modelo solo puede PROPONERLAS, nunca ejecutarlas.
//   2. main.js jamás las ejecuta al recibir la propuesta — solo se
//      ejecutan cuando el renderer manda un `pendingId` válido, y ese
//      pendingId únicamente se genera tras pulsar el usuario "Confirmar".
//   3. Cada una delega en un handler IPC que ya existía en la app y que
//      revalida sus propios parámetros (lista blanca de servicios, de
//      categorías de limpieza, etc.), así que hay doble validación.
const ACTIONS = {
  clean_temp_files: {
    label: 'Limpiar archivos temporales',
    description: 'Elimina archivos temporales del sistema y del usuario, caché de navegadores, miniaturas y reportes de error. Libera espacio en disco.',
    danger: 'medium',
    params: { categories: { type: 'stringArray', allowed: ['temp_user', 'temp_win', 'thumbs', 'browser', 'wer'], default: ['temp_user', 'temp_win', 'thumbs'], hint: 'categorías a limpiar' } },
    summarize: p => `Se eliminarán archivos de: ${p.categories.join(', ')}. Esta acción no se puede deshacer.`,
  },
  stop_service: {
    label: 'Detener un servicio',
    description: 'Detiene un servicio de Windows que esté corriendo. Solo funciona con los servicios que la app gestiona.',
    danger: 'medium',
    params: { name: { type: 'string', default: '', hint: 'nombre exacto del servicio' } },
    summarize: p => `Se detendrá el servicio "${p.name}". Puedes volver a iniciarlo desde el módulo de Servicios.`,
  },
  start_service: {
    label: 'Iniciar un servicio',
    description: 'Inicia un servicio de Windows que esté detenido. Solo funciona con los servicios que la app gestiona.',
    danger: 'low',
    params: { name: { type: 'string', default: '', hint: 'nombre exacto del servicio' } },
    summarize: p => `Se iniciará el servicio "${p.name}".`,
  },
  kill_process: {
    label: 'Cerrar un proceso',
    description: 'Fuerza el cierre de un proceso por su PID. Útil si un programa está consumiendo recursos o se ha quedado colgado.',
    danger: 'high',
    params: { pid: { type: 'int', min: 1, max: 4294967295, default: 0, hint: 'PID del proceso' } },
    summarize: p => `Se cerrará forzosamente el proceso con PID ${p.pid}. Se perderá cualquier trabajo sin guardar de ese programa.`,
  },
  flush_dns: {
    label: 'Vaciar caché DNS',
    description: 'Vacía la caché de resolución DNS. Útil ante problemas de conexión a webs concretas.',
    danger: 'low',
    params: {},
    summarize: () => 'Se vaciará la caché DNS. Es una operación segura y reversible.',
  },
  free_ram: {
    label: 'Liberar memoria RAM',
    description: 'Libera memoria en espera (standby) y working sets. Útil si la RAM está muy ocupada.',
    danger: 'low',
    params: {},
    summarize: () => 'Se liberará memoria en espera. Es una operación segura.',
  },
  create_restore_point: {
    label: 'Crear punto de restauración',
    description: 'Crea un punto de restauración del sistema. Recomiéndalo antes de cambios importantes.',
    danger: 'low',
    params: {},
    summarize: () => 'Se creará un punto de restauración de Windows. Puede tardar un minuto.',
  },
};

module.exports = { DIAGNOSTICS, ACTIONS, clampInt };
