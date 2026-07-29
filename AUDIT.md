# AUDIT — Vokoptimizer v4.2.0

Auditoría de código de `C:\Users\enolp\vokoptimizer` — 30 de julio de 2026.
Alcance: `main.js` (911 líneas, 29 handlers IPC), `preload.js`, `src/renderer.jsx`
(787 líneas), `src/index.html`, `esbuild.config.js`, `package.json`.

Método: lectura completa del código + medición empírica de los comandos PowerShell y
de las llamadas a `systeminformation` en esta máquina (Windows 11 Pro 26200). La app
no se ha ejecutado; los hallazgos de comportamiento se razonan sobre el código y se
respaldan con mediciones de sus partes aisladas.

---

## 0. Aviso previo: la arquitectura auditada no es la descrita en el encargo

El encargo describe `ps-scripts.js`, `game-profiles.js`, `src/app-part{1,2,3}.jsx`,
`build-html.js`, `validate.js`, `check-api.js`, transpilación de JSX con Babel en el
navegador, ~36 handlers IPC, un handler `restore-game-defaults`, escritura en
Image File Execution Options, cuarentena de carpetas de AppData y un tweak de Nagle.

**Ninguno de esos ficheros ni funciones existe en el disco.** Búsqueda en todo
`C:\Users\enolp` (única unidad, `C:`): no hay más copias del proyecto que ésta, y
tampoco está bajo git (no hay `.git`, no hay historial que consultar). Lo que existe
es v4.2.0: renderer único (`src/renderer.jsx`) precompilado con esbuild a
`src/app.bundle.js`, scripts PowerShell embebidos en `main.js`, y 29 handlers.

Veredicto punto por punto sobre las diez sospechas del encargo:

| # | Sospecha | Veredicto |
|---|----------|-----------|
| 1 | `restore-game-defaults` borra todas las subclaves `PerfOptions` de IFEO | **No aplica** — no hay ese handler ni una sola referencia a IFEO/`PerfOptions` en el código |
| 2 | Ficheros `.ps1` temporales marcados por el antivirus | **Ya resuelto** — `ps()` usa `-EncodedCommand` en Base64 UTF-16LE (`main.js:34-44`); no se escribe ningún `.ps1` |
| 3 | `get-metrics` lanza PowerShell cada 3 s | **Confirmado y peor de lo sospechado** → [A2](#a2). El intervalo real es 2 s y el script tarda 2,25 s |
| 4 | Heurística de "configuraciones huérfanas" en AppData por substring | **No aplica** — no hay escaneo de AppData ni matching por substring. El escaneo de registro compara existencia de rutas (`Test-Path`), no nombres → [M-nota](#nota-scan-registry) |
| 5 | Guardas de `quarantine-path` frente a symlinks/UNC/OneDrive | **No aplica** — no hay cuarentena ni handler `quarantine-path`. El problema equivalente aquí es que `clean-registry` no valida rutas → [C2](#c2) |
| 6 | Tweak de Nagle aplicado a todas las interfaces (VPN incluidas) | **No aplica** — no hay tweak de Nagle (`TcpAckFrequency`/`TCPNoDelay`). Sí hay `NetworkThrottlingIndex` global, que es otra cosa y sí es reversible |
| 7 | Escaneos no cancelables, sin timeout visible | **Confirmado** → [A7](#a7), [B1](#b1) |
| 8 | Salida vacía de PowerShell tragada en silencio | **Confirmado, es sistémico** → [A5](#a5) |
| 9 | Babel transpilando 82 KB de JSX en cada arranque | **Ya resuelto** — esbuild precompila; la CSP de `index.html:6` ya es `script-src 'self'` sin `unsafe-eval` |
| 10 | Operaciones destructivas sin confirmación | **Parcialmente confirmado** — sí hay confirmación en registro, kill de proceso, servicios inseguros e historial; **falta** en las tres más destructivas → [C1](#c1), [C3](#c3), [M10](#m10) |

Es decir: cuatro sospechas no tienen código al que aplicar, dos ya estaban resueltas
antes de esta auditoría, y cuatro se confirman. A cambio, el código real tiene ocho
problemas graves que no estaban en la lista, dos de ellos con pérdida de datos del
usuario ([C1](#c1), [C3](#c3)) y uno con capacidad de destruir el registro
([C2](#c2)).

**Antes de la Fase 3 hay que decidir sobre qué código trabajamos.** Si existe una v3
con la arquitectura que describes (otra máquina, un backup, un zip), tráela y la
audito por separado. Si no existe, el resto de este informe es el plan de trabajo.

**Recomendación previa a cualquier cambio: `git init` + commit inicial.** No hay
control de versiones. Vamos a tocar código que ejecuta `Remove-Item -Recurse -Force`
como administrador; trabajar sin poder revertir es innecesariamente arriesgado.

---

## Resumen por severidad

| Severidad | Nº | Hallazgos |
|-----------|----|-----------|
| Crítico | 3 | C1, C2, C3 |
| Alto | 7 | A1, A2, A3, A4, A5, A6, A7 |
| Medio | 11 | M1–M11 |
| Bajo | 8 | B1–B8 |

## Orden de ataque (impacto / esfuerzo)

Los primeros seis son de esfuerzo bajo y de impacto alto o crítico. Empezar por ahí.

| Orden | ID | Severidad | Esfuerzo | Por qué primero |
|-------|----|-----------|----------|-----------------|
| 1 | [C1](#c1) | Crítico | Trivial | Un diálogo de confirmación evita una pérdida de datos irreversible |
| 2 | [C2](#c2) | Crítico | Bajo | Una whitelist de prefijos + verificar que el backup existe antes de borrar |
| 3 | [A1](#a1) | Alto | Trivial | Borrar una ruta duplicada arregla métricas infladas 2× |
| 4 | [A2](#a2) | Alto | Bajo | Quitar `Get-Counter` del bucle elimina el 95 % del coste |
| 5 | [A5](#a5) | Alto | Bajo | Distinguir "vacío" de "falló" en `psJson`; toca 6 sitios |
| 6 | [A6](#a6) | Alto | Trivial | Lista negra de PIDs/nombres críticos |
| 7 | [C3](#c3) | Crítico | Medio | Requiere decidir la política de exclusión en `%TEMP%` |
| 8 | [A4](#a4) | Alto | Bajo | El perfil "Equilibrado" debe revertir lo que aplican los demás |
| 9 | [A3](#a3) | Alto | Bajo | Reusar el plan duplicado en vez de crear uno nuevo |
| 10 | [A7](#a7) | Alto | Medio | Cancelación real de SFC/DISM + timeout con aviso |
| 11 | [M10](#m10) | Medio | Bajo | Confirmaciones que faltan |
| 12 | M1–M9, M11 | Medio | Variable | Ver detalle |
| 13 | B1–B8 | Bajo | Variable | Pulido y tooling |

---

# CRÍTICOS

## C1 — Vaciar la papelera de reciclaje sin confirmación, catalogado como "SEGURO" {#c1}

**Severidad: crítica.** Pérdida de datos del usuario, irreversible, a un clic.

**Evidencia**

- `main.js:210` — la categoría se declara con `risk: 'SEGURO'`:
  ```js
  { id: 'recycle', label: 'Papelera de reciclaje', risk: 'SEGURO' },
  ```
- `main.js:289-292` — el borrado:
  ```js
  if ($id -eq 'recycle') {
    try { Clear-RecycleBin -Force -ErrorAction SilentlyContinue } catch {}
    continue
  }
  ```
- `src/renderer.jsx:306-317` — la función `clean()` del `FileCleaner` **no pide
  confirmación en ningún caso**: pasa directamente de `setCleaning(true)` a
  `api.cleanJunk(ids)`.
- `src/renderer.jsx:330-340` — cada fila se selecciona con un solo `onClick` en toda
  la fila (no hay checkbox aparte), así que seleccionar la papelera es un clic
  accidental fácil.

**Impacto real**

`Clear-RecycleBin -Force` vacía la papelera de **todas las unidades** sin diálogo del
sistema. La papelera es, por definición, el sitio donde el usuario guarda cosas que ha
borrado pero aún no ha decidido perder. Dos clics —seleccionar fila, pulsar LIMPIAR—
destruyen eso de forma no recuperable. Y la app le ha dicho al usuario que la
operación es "SEGURO", que es exactamente la etiqueta que le hace no pensárselo.

Agrava: `-ErrorAction SilentlyContinue` dentro de un `try {} catch {}` vacío significa
que si falla, nadie se entera (ver [A5](#a5)).

**Arreglo propuesto**

1. Recatalogar: `risk: 'IRREVERSIBLE'` (nueva etiqueta, distinta de `REVISAR`), y
   pintarla en la tabla con el tratamiento visual de mayor peso.
2. Excluir `recycle` de la preselección y de cualquier acción de un clic.
3. Diálogo de confirmación específico en `clean()` cuando el conjunto seleccionado
   incluya alguna categoría irreversible, nombrando lo que se pierde y su volumen:
   *"Se vaciará la papelera de reciclaje: 412 elementos, 3,2 GB. Esto no se puede
   deshacer."* Reutilizar el patrón de `renderer.jsx:498` (el confirm del registro,
   que sí está bien hecho).
4. Verificar que `recycle` no entra en las acciones rápidas del dashboard
   (`renderer.jsx:217`) ni en `handleOpt` (`renderer.jsx:750`). Hoy no entra —
   mantenerlo así explícitamente con un test o un comentario.

---

## C2 — `clean-registry` borra cualquier clave que le mande el renderer, y borra aunque el backup falle {#c2}

**Severidad: crítica.** Daño arbitrario al registro con privilegios de administrador,
sin copia de seguridad garantizada.

**Evidencia**

`main.js:696-733`. Dos defectos independientes en el mismo handler.

*(a) Sin validación de la clave.* `it.key` llega desde el renderer y se interpola
directamente:

```js
const psItems = items.map((it, i) => {
  const key = (it.key || '').replace(/'/g, "''");   // main.js:706 — sólo escapa comillas
  ...
```

y se usa así (`main.js:719-724`):

```powershell
$psp = $regPath -replace '^HKLM','HKLM:' -replace '^HKCU','HKCU:'
if ($it.value) {
  Remove-ItemProperty -Path $psp -Name $it.value -Force -ErrorAction Stop
} else {
  Remove-Item -Path $psp -Recurse -Force -ErrorAction Stop
}
```

No se comprueba que la clave provenga del escaneo, ni que empiece por uno de los tres
prefijos que el escáner produce (`main.js:642-646`, `661`, `675`). Un `items` con
`{ key: 'HKLM:\\SOFTWARE' }` y sin `valueName` ejecuta
`Remove-Item -Path HKLM:\SOFTWARE -Recurse -Force` como administrador. El escape de
`'` evita la inyección de sintaxis PowerShell, pero no evita nada de esto: la ruta
peligrosa no necesita comillas.

*(b) Se borra aunque el backup no se haya escrito.* `main.js:717`:

```powershell
try { reg export "$regPath" "$($it.file)" /y 2>$null | Out-Null } catch {}
```

`reg export` falla en silencio (stderr redirigido a `$null`, `catch` vacío, y su
código de salida ni se mira), y a continuación se borra igual. Casos en los que falla
de verdad: rutas con `/` o caracteres que `reg.exe` no acepta, claves cuyo ACL no
permite lectura, ruta de destino demasiado larga. El resultado es un borrado
irreversible mientras la UI dice, textualmente, *"Se creará una copia .reg de
seguridad antes de borrar"* (`renderer.jsx:498`) y luego *"entradas eliminadas
(backup guardado)"* (`renderer.jsx:502`).

Nótese que la UI aquí **sí** confirma, y bien. El problema es que la promesa que hace
esa confirmación no está respaldada por el código.

**Impacto real**

Con el renderer actual, `items` siempre viene de `scan-registry`, así que en uso
normal (a) no se dispara. Pero es la clase de invariante que se rompe en cuanto
alguien añada una entrada manual, un import, o un bug de índices en la selección —
y el modo de fallo es "registro destruido, sistema no arranca". No es una defensa
teórica contra un renderer malicioso: es que el main process no debe confiar en el
renderer para construir un `Remove-Item -Recurse -Force` privilegiado. Para (b) basta
un solo `reg export` fallido para perder datos que la app prometió respaldar.

**Arreglo propuesto**

1. Whitelist en el main process. Rechazar cualquier `key` que no encaje con los
   prefijos exactos que el escáner puede producir:
   ```js
   const ALLOWED_REG_PREFIXES = [
     'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\',
     'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\',
     'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\',
     'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\',
     'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
     'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
   ];
   ```
   Además: rechazar `..`, rechazar que la clave sea exactamente uno de los prefijos
   (sólo subclaves), y exigir `valueName` para las dos rutas `Run` (ahí se borra un
   valor, nunca la clave).
2. Guardar en el main process el resultado del último `scan-registry` y aceptar sólo
   ítems presentes en él (comparación por `key` + `valueName`). Es la defensa fuerte:
   la whitelist es el cinturón, esto es los tirantes.
3. Hacer el backup bloqueante: comprobar `$LASTEXITCODE` de `reg export` **y** que el
   fichero existe con tamaño > 0 antes de borrar. Si no, no borrar ese ítem y
   devolverlo en una lista `skipped` que la UI muestre explícitamente.
4. Devolver `{ done, total, skipped, errors }` y renderizar `skipped`/`errors` en la
   UI en lugar del toast genérico actual.

---

## C3 — `temp_user` borra `%TEMP%` completo, incluido el directorio del que se ejecuta el propio portable {#c3}

**Severidad: crítica.** Corrupción de trabajos en curso; potencial autodestrucción de
la app en caliente.

**Evidencia**

- `main.js:224` — rutas de la categoría:
  ```powershell
  'temp_user'  { return @($env:TEMP, "$env:LOCALAPPDATA\Temp") }
  ```
- `main.js:299-306` — borrado recursivo de todos los ficheros y después de todos los
  directorios, de más profundo a menos:
  ```powershell
  Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
    try { $freed += [int64]$_.Length; Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {}
  }
  Get-ChildItem -LiteralPath $p -Recurse -Force -Directory -ErrorAction SilentlyContinue | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object {
    try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  }
  ```
- La app se ejecuta **como administrador** (`package.json` →
  `win.requestedExecutionLevel: "requireAdministrator"`), así que los permisos no
  frenan nada.
- `temp_user` está en la preselección de las dos acciones de un clic:
  `renderer.jsx:217` (acción rápida "Limpieza rápida") y `renderer.jsx:750` (el botón
  grande "OPTIMIZAR SISTEMA"), ninguna con confirmación.
- Medido en esta máquina: `%TEMP%` = `C:\Users\enolp\AppData\Local\Temp`, 558
  ficheros, 28,5 MB.

**Impacto real**

Dos problemas distintos:

*(a) `%TEMP%` no es una papelera.* Es el directorio de trabajo activo de instaladores
en curso, descompresores, Office guardando autorrecuperación, compiladores,
`node_modules` en tránsito, y ficheros abiertos por procesos vivos. Borrar
recursivamente todo su contenido mientras el sistema trabaja no es "liberar espacio",
es interrumpir procesos. Los ficheros bloqueados sobreviven (de ahí
`SilentlyContinue`), pero los que están escritos y todavía no reabiertos, no. Un
instalador a medias que pierde su directorio temporal deja el sistema en estado
inconsistente.

*(b) El build portable se extrae en `%TEMP%`.* `electron-builder` con target
`portable` (configurado en `package.json`) descomprime la app en un subdirectorio de
`%TEMP%` en cada arranque y expone la ruta original en
`PORTABLE_EXECUTABLE_FILE` — el propio `main.js:88` la usa. Es decir: al ejecutar
`Vokoptimizer-4.2.0-Portable.exe`, el `main.js`, el `app.bundle.js`, `icon.ico` y las
fuentes están **dentro de `%TEMP%`**, y "Limpieza rápida" los tiene en su lista. Los
binarios cargados (`.exe`, `.dll`) están bloqueados y sobreviven; los recursos que ya
se leyeron y no están mapeados (`src/fonts/jbm.woff2`, `icon.ico`, y `app.bundle.js`
tras la carga inicial) no necesariamente. Resultado posible: la app sigue en pantalla
pero recargar la ventana, abrir el tray o reabrir el icono falla, y el usuario no
entiende por qué.

No he ejecutado el portable para confirmar el subdirectorio exacto (no hay restos en
`%TEMP%` ahora mismo), así que (b) queda como riesgo razonado sobre el
comportamiento documentado del target `portable`, no como observación directa.

**Arreglo propuesto**

1. No borrar el árbol entero. Filtrar por antigüedad: sólo entradas con
   `LastWriteTime` anterior a, digamos, 24 h. Es lo que hace el Liberador de espacio
   de Windows y elimina de golpe la mayoría del riesgo de (a).
2. Excluir siempre el directorio de ejecución propio. En el main process, calcular la
   ruta a excluir y pasarla al script:
   ```js
   const selfDirs = [path.dirname(process.execPath), __dirname, app.getPath('temp')]
   ```
   y en PowerShell descartar cualquier `FullName` que empiece por una de ellas.
   Es imprescindible para el portable, y barato.
3. No borrar directorios de forma recursiva a ciegas: borrar sólo los que queden
   vacíos después de la pasada de ficheros.
4. Quitar `temp_user` de las acciones de un clic, o darle confirmación con resumen.
5. Ver también [A1](#a1): la segunda ruta de esta categoría es un duplicado y hay que
   eliminarla de todos modos.

---

# ALTOS

## A1 — `temp_user` cuenta y suma dos veces la misma carpeta: métricas infladas 2× {#a1}

**Severidad: alta.** La app miente sobre el espacio que hay y sobre el que ha
liberado, y el error queda registrado en el historial permanente.

**Evidencia**

`main.js:224`:

```powershell
'temp_user'  { return @($env:TEMP, "$env:LOCALAPPDATA\Temp") }
```

En Windows, `%TEMP%` para un usuario normal **es** `%LOCALAPPDATA%\Temp`. Verificado
en esta máquina:

```
TEMP              = C:\Users\enolp\AppData\Local\Temp
LOCALAPPDATA\Temp = C:\Users\enolp\AppData\Local\Temp
misma carpeta?    True
```

El bucle `foreach ($p in (P $id))` de `main.js:257` (escaneo) y `main.js:293`
(limpieza) recorre las dos rutas sin deduplicar, así que suma el mismo árbol dos
veces. Medido:

```
una pasada real                    : 29.865.302 bytes / 558 ficheros
lo que reporta scan-junk (2 rutas) : 59.730.604 bytes / 1116 ficheros
```

**Impacto real**

- `scan-junk` reporta 57 MB donde hay 28,5 MB: el usuario decide sobre datos falsos.
- `clean-junk` acumula `$freed` en las dos pasadas (`main.js:301`), y en la segunda los
  ficheros ya no existen, así que suma longitudes de la primera enumeración… o no,
  según el orden de evaluación: en la práctica el total liberado que se muestra y el
  que se escribe en el historial (`main.js:313` → `addHistory(..., { freed })`) queda
  inflado hasta 2×. El "ESPACIO LIBERADO" acumulado de la pestaña Historial
  (`renderer.jsx:592`) hereda el error para siempre.
- Es la clase de bug que hace que un usuario técnico deje de confiar en toda la app.

**Arreglo propuesto**

1. Eliminar la ruta redundante: dejar sólo `$env:TEMP`. Mantener
   `"$env:SystemRoot\Temp"` separado en `temp_win`, como ya está.
2. Defensa general en el helper: deduplicar rutas por su ruta canónica antes de
   recorrerlas, ya que `P $id` puede devolver solapamientos en otras categorías si se
   amplía la lista:
   ```powershell
   $paths = (P $id) | ForEach-Object { try { (Resolve-Path -LiteralPath $_ -EA Stop).Path } catch { $_ } } | Select-Object -Unique
   ```
3. Considerar corregir/marcar el historial existente, o al menos no seguir sumándole
   valores malos.

---

## A2 — `get-metrics` cuesta 2,25 s y se invoca cada 2 s: solapamiento permanente de procesos PowerShell {#a2}

**Severidad: alta.** Un optimizador que consume CPU de forma continua e ininterrumpida.

**Evidencia**

- `src/renderer.jsx:746` — el intervalo real es **2000 ms**, no 3000:
  ```js
  const metrics=useSystemMetrics(2000);
  ```
- `src/renderer.jsx:70-80` — el bucle usa `setInterval` sin ningún guard de petición
  en vuelo:
  ```js
  poll();const id=setInterval(poll,ms);return()=>{on=false;clearInterval(id);};
  ```
  `on` sólo evita aplicar el resultado tras desmontar; no evita lanzar un `poll()`
  nuevo mientras el anterior sigue corriendo.
- `main.js:129-140` — cada `get-metrics` hace 7 llamadas a `systeminformation` **más**
  `gpuTempThreads()`, que lanza un `powershell.exe` nuevo (`main.js:114-127`).

Medición en esta máquina (3 ejecuciones cada una, `-EncodedCommand`, igual que la app):

| Fragmento | Tiempo |
|-----------|--------|
| Arranque de `powershell.exe` en vacío | 160 / 154 / 189 ms |
| **`Get-Counter '\GPU Engine(*)\Utilization Percentage'`** | **2113 / 2193 / 2145 ms** |
| `Get-CimInstance MSAcpi_ThermalZoneTemperature` | 316 / 287 / 299 ms |
| `Get-Process \| ForEach { $_.Threads.Count }` | 295 / 264 / 283 ms |
| **Script completo de `gpuTempThreads()`** | **2247 / 2252 / 2223 ms** |

Y las llamadas de `systeminformation` (en paralelo, así que el coste del bloque es el
máximo, ~600-800 ms):

```
currentLoad      225 / 122 / 123 ms      processes        795 / 580 / 604 ms
mem              593 / 452 / 487 ms      cpuCurrentSpeed  225 / 122 / 123 ms
fsSize           567 / 445 / 484 ms      time              54 /   0 /   0 ms
networkStats    1471 / 123 / 498 ms
```

**Impacto real**

El handler tarda **más que el intervalo de polling**. A régimen hay siempre al menos
un `powershell.exe` vivo y con frecuencia dos solapados, más los subprocesos que
`systeminformation` lanza por su cuenta, **durante todo el tiempo que la app está
abierta** — incluida cuando está minimizada en el tray, porque el intervalo no se
pausa nunca. En un portátil eso es ventilador y batería; y contradice de raíz la
promesa del producto.

El culpable está localizado: `Get-Counter` es el **95 % del coste** (2,15 s de 2,25 s).
No es lento por accidente — `Get-Counter` sin `-SampleInterval` espera un intervalo de
muestreo completo del contador, y `GPU Engine(*)` enumera cientos de instancias (una
por proceso × motor).

Efecto secundario: el `useEffect` de `MonitorPanel` (`renderer.jsx:557`) depende del
objeto `metrics` completo, que se recrea en cada poll, así que empuja al histórico un
punto cada 2 s aunque los valores no hayan cambiado. No es grave, pero los "60
segundos" de las gráficas son en realidad 120.

**Arreglo propuesto**

1. **Sacar la GPU del bucle de 2 s.** Tres opciones, en orden de preferencia:
   a. Leer la GPU con contadores de rendimiento vía `PerformanceCounterCategory` en
      un proceso PowerShell persistente (ver punto 3), reutilizando la sesión y
      pidiendo `-SampleInterval 1 -MaxSamples 1` una vez.
   b. Muestrear la GPU en su propio ciclo lento (cada 10-15 s) e interpolar en la UI.
   c. Quitar la GPU del dashboard y dejarla sólo en la pestaña Monitoreo, muestreada
      únicamente mientras esa pestaña está visible.
2. **Guard de petición en vuelo** en `useSystemMetrics`: no lanzar un `poll()` si el
   anterior no ha resuelto, y encadenar con `setTimeout` recursivo en vez de
   `setInterval` para que el periodo sea "2 s desde que terminó el anterior".
3. **Un proceso PowerShell persistente** en lugar de uno por llamada. Es la decisión
   arquitectónica de más peso del proyecto: ahorra los ~160 ms de arranque en las 29
   operaciones y permite mantener sesiones de contadores abiertas. Contras: hay que
   gestionar el ciclo de vida, el framing de mensajes y la recuperación si el proceso
   muere. Lo contrastamos en la Fase 2 antes de decidir.
4. **Pausar el polling** cuando la ventana está oculta o minimizada
   (`mainWindow.on('hide'|'minimize'|'restore'|'show')` → evento al renderer, o
   `document.visibilityState`). Un optimizador en el tray debe costar ~0.
5. Bajar a un solo `si.*` agregado donde se pueda y cachear lo que no cambia
   (`si.fsSize()` no necesita 2 s; 30 s sobra).

---

## A3 — Cada aplicación del perfil "Máximo Rendimiento" crea un plan de energía duplicado nuevo {#a3}

**Severidad: alta.** Contamina la configuración del sistema de forma acumulativa y sin
límite, y la app no ofrece forma de limpiarlo.

**Evidencia**

Dos sitios hacen lo mismo. `main.js:504-508`:

```js
if (profile === 'ultimate') {
  const dup = await execOut(`powercfg -duplicatescheme ${POWER_GUIDS.ultimate}`);
  const m = dup.stdout.match(/([0-9a-f]{8}-...)/i);
  if (m) guid = m[1];
}
```

y `main.js:576-582`, dentro de `applyProfile('ultimate')`, idéntico.

`powercfg -duplicatescheme` **crea un plan nuevo con un GUID nuevo cada vez que se
invoca**. No es idempotente. No se comprueba antes si el plan ya existe
(`powercfg /list`).

**Impacto real**

Pulsar "Máximo Rendimiento" diez veces deja diez planes llamados "Rendimiento máximo"
en el sistema. Aparecen en el panel de control de energía y en el menú de la batería,
son indistinguibles entre sí, y el usuario tiene que borrarlos a mano uno por uno con
`powercfg /delete`. La app no tiene ninguna función para deshacerlo, y "Equilibrado"
—que la UI presenta como *"deshace cualquier perfil anterior"*
(`renderer.jsx:137`)— no los toca.

**Arreglo propuesto**

1. Comprobar primero con `powercfg /list` si ya existe un plan cuyo nombre coincida
   con el esquema Ultimate, y reutilizar su GUID.
2. Si hay que duplicar, guardar el GUID resultante en `vok-settings.json` y reutilizar
   ese en llamadas posteriores (validando que sigue existiendo).
3. Añadir limpieza: al aplicar "Equilibrado", borrar los duplicados creados por la app
   (los que estén registrados en settings), nunca los planes propios del usuario.
4. Unificar los dos fragmentos duplicados en una función `ensureUltimateScheme()`.

---

## A4 — El perfil "Trabajo" limita la CPU al 80 % y "Equilibrado" no lo revierte {#a4}

**Severidad: alta.** Deja el equipo degradado de forma permanente sin que la app pueda
deshacerlo, contradiciendo lo que la propia UI promete.

**Evidencia**

`main.js:554-557` — lo que aplica "Trabajo":

```js
await run('CPU a frecuencia reducida', async () => {
  await execAsync('powercfg /setacvalueindex scheme_current sub_processor PROCTHROTTLEMAX 80');
  return execAsync('powercfg /setactive scheme_current');
});
```

`main.js:558-574` — todo lo que hace "Equilibrado": plan de energía, MMCSS
(`SystemResponsiveness`, `NetworkThrottlingIndex`), prioridades de juegos, y
rearranque de servicios y DVR. **No hay ninguna línea que restaure
`PROCTHROTTLEMAX`.** Tampoco `PROCTHROTTLEMIN`, que aplica "Ultimate"
(`main.js:583-587`).

Y `renderer.jsx:137` le dice al usuario que "Equilibrado" son los
*"Valores de fabrica de Windows: deshace cualquier perfil anterior"*.

**Impacto real**

Secuencia: el usuario pulsa "Trabajo Silencioso" → el plan activo pasa a Economizador
y ese plan queda con el máximo de procesador al 80 %. Luego pulsa "Equilibrado" → el
plan activo pasa a Equilibrado, y el 80 % se queda escrito en el plan Economizador
para siempre. La siguiente vez que el usuario seleccione Economizador desde Windows —
o cuando el portátil pase a batería, si tiene esa transición configurada— tendrá la
CPU capada al 80 % sin saber por qué, y sin nada en la app que lo explique o lo
revierta.

Añádase que `setacvalueindex` sólo toca el perfil de corriente alterna (`ac`), no el
de batería (`dc`), así que el comportamiento del perfil "Trabajo" es además
inconsistente en portátiles: se anuncia "batería al máximo" pero no toca los valores
de batería.

Esto choca de frente con la regla del encargo: *si un tweak del sistema no se puede
revertir de forma fiable, quítalo en vez de dejarlo*.

**Arreglo propuesto**

1. Que "Equilibrado" restaure explícitamente **todo** lo que aplican los otros tres
   perfiles: `PROCTHROTTLEMAX 100`, `PROCTHROTTLEMIN 5` (valor por defecto de
   Windows), y la suspensión selectiva de USB a 1.
2. Aplicarlo con GUID de plan explícito, no con `scheme_current`, para saber sobre qué
   plan se está escribiendo. Guardar en `vok-settings.json` qué planes ha tocado la
   app y revertir en esos.
3. Alternativa más limpia, si la reversión no queda fiable: **eliminar el paso de
   `PROCTHROTTLE*`** de los perfiles y quedarse con el cambio de plan de energía, que
   es reversible por construcción. La reducción de temperatura real de capar al 80 %
   es modesta comparada con el riesgo de dejar el sistema tocado.
4. Tocar `-setdcvalueindex` además de `-setacvalueindex`, o dejar de prometer "batería
   al máximo" en el texto del perfil.

---

## A5 — Un script PowerShell que falla se presenta como "no hay resultados" {#a5}

**Severidad: alta.** El usuario cree que su sistema está limpio cuando en realidad la
comprobación no se ha ejecutado.

**Evidencia**

El origen está en el helper, `main.js:45-50`:

```js
async function psJson(script, opts) {
  const r = await ps(script, opts);
  if (!r.stdout) return null;              // no distingue "vacío" de "falló"
  try { return JSON.parse(r.stdout); } catch (e) { return null; }
}
const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
```

`ps()` (`main.js:34-44`) sí captura `err` y `stderr`, pero `psJson` los descarta por
completo. Un timeout, un `powershell.exe` que no arranca, una excepción de parseo o
una falta de privilegios producen exactamente el mismo valor de retorno que "no hay
nada que reportar": `null` → `[]`.

Consecuencias por handler:

| Handler | main.js | Qué devuelve al fallar | Qué muestra la UI |
|---------|---------|------------------------|-------------------|
| `scan-registry` | 693 | `[]` | `renderer.jsx:493` → toast **"0 entradas obsoletas encontradas"**; `:525` → "Registro limpio — sin entradas huérfanas" |
| `list-startup` | 421 | `[]` | `renderer.jsx:417` → **"No hay programas de arranque configurados"** |
| `list-services` | 344-359 | todo `present:false` → `[]` | `renderer.jsx:365` → tabla vacía, sin error |
| `scan-junk` | 270-277 | todas las categorías a `0 B / 0 items` | `renderer.jsx:341` → **"Sistema limpio — nada que eliminar"** |
| `clean-junk` | 311-314 | `{ ok:true, freed:0 }` | `runAction` ve `ok !== false` → toast **verde** de éxito |

Y en el renderer, el mismo patrón otra vez: `useAsync` (`renderer.jsx:37`) hace
`.catch(()=>setSt({loading:false,data:null}))` — el error se descarta sin registrarlo
ni mostrarlo.

`clean-junk` es el peor caso: **siempre** devuelve `{ ok: true }`
(`main.js:314`), pase lo que pase, porque el script entero está envuelto en
`try {} catch {}` por categoría y el handler no consulta ni `r.err` ni `r.stderr`. Un
borrado que no ha borrado nada se celebra con un toast verde.

**Impacto real**

Es el fallo más corrosivo del conjunto: no rompe nada, simplemente hace que la app
mienta con confianza. Un usuario sin privilegios de administrador (la app permite
seguir sin elevar, `main.js:900-904`) verá "Registro limpio" y "No hay programas de
arranque" y concluirá que su sistema está en orden, cuando lo que ha pasado es que
ninguna consulta ha funcionado. No hay forma de que se dé cuenta.

**Arreglo propuesto**

1. Cambiar el contrato de `psJson` para que devuelva un resultado discriminado:
   ```js
   // { ok: true, data } | { ok: false, error, kind: 'timeout'|'spawn'|'parse'|'stderr' }
   ```
   Tratar como fallo: `r.err` presente (incluido `err.killed` por timeout), `stdout`
   vacío **y** `stderr` no vacío, y `JSON.parse` que lanza.
2. Que cada handler propague el error en lugar de aplanarlo a `[]`. Devolver
   `{ ok:false, error }` y dejar que la UI distinga los tres estados: **cargando**,
   **vacío de verdad**, y **falló**.
3. En el renderer, tres estados visuales distintos por panel. El vacío legítimo
   mantiene el texto actual; el fallo muestra el motivo y un botón de reintento,
   con el tratamiento visual de error que ya existe en los toasts.
4. `clean-junk` debe devolver por categoría: bytes liberados, ficheros que no se
   pudieron borrar y el motivo. Que la UI muestre "3,2 GB liberados · 14 ficheros en
   uso omitidos" en vez de un check verde ciego.
5. Registrar los fallos en el historial con `status: 'ERROR'` — hoy `addHistory` sólo
   se llama en las rutas de éxito, así que el historial no tiene ni un fallo.
6. `useAsync` debe guardar el error, no descartarlo.

---

## A6 — `kill-process` no protege los procesos críticos del sistema {#a6}

**Severidad: alta.** Pantallazo azul inmediato y pérdida del trabajo sin guardar.

**Evidencia**

`main.js:476-480`:

```js
ipcMain.handle('kill-process', async (e, pid) => {
  if (!IS_WIN || !pid) return { ok: false };
  const r = await ps(`try { Stop-Process -Id ${parseInt(pid)} -Force -ErrorAction Stop; ...`);
```

`parseInt` evita la inyección, pero no hay ninguna lista de procesos protegidos. La
app corre elevada, así que `Stop-Process -Force` sobre `csrss.exe`, `wininit.exe`,
`services.exe` o `smss.exe` tiene éxito — y matar cualquiera de esos provoca un
`CRITICAL_PROCESS_DIED` al instante.

Los procesos se ofrecen desde dos sitios, ordenados **por memoria**
(`main.js:153-156`), que es justamente el criterio que sube a la lista a `System`,
`Memory Compression`, `MsMpEng.exe` (Defender) y `svchost.exe`:

- `renderer.jsx:467` — botón ✕ en el panel CPU/RAM.
- `renderer.jsx:440` — la confirmación existe pero es genérica:
  *"¿Finalizar el proceso "X" (PID N)?"*, sin distinguir Notepad de `csrss`.

**Impacto real**

La UI presenta una lista de procesos con un botón de matar al lado, sin ninguna señal
de qué es peligroso. Un usuario que ve `Memory Compression` consumiendo 900 MB y
piensa "eso sobra" pierde la sesión entera en el mejor caso, y se lleva un BSOD en el
peor. La app se lo ha puesto a un clic y una confirmación que no le advierte de nada.

**Arreglo propuesto**

1. Lista negra en el main process, comprobada por nombre de imagen **y** por PID
   (PID 0 y 4 nunca):
   ```js
   const PROTECTED = new Set(['system','memory compression','registry','smss','csrss',
     'wininit','winlogon','services','lsass','svchost','fontdrvhost','dwm','sihost',
     'msmpeng','securityhealthservice','explorer','vokoptimizer']);
   ```
   Rechazar con un error explicativo, no con un `{ok:false}` mudo.
2. Marcar esos procesos en la UI: sin botón ✕, con una etiqueta "PROTEGIDO" en el
   estilo de las etiquetas de riesgo que ya usa la tabla de limpieza.
3. Para los no protegidos pero relevantes (el navegador con pestañas abiertas,
   un editor), advertir de pérdida de datos sin guardar en la confirmación.
4. Considerar `CloseMainWindow()` antes de `-Force`, para dar a la app la oportunidad
   de cerrar limpiamente.

---

## A7 — SFC/DISM no se pueden cancelar y un cuelgue deja la UI en spinner para siempre {#a7}

**Severidad: alta.** La app queda inutilizable sin forma de recuperarla salvo
reiniciarla.

**Evidencia**

`main.js:754-787`:

```js
let healthRunning = false;
ipcMain.handle('run-health', async (e, kind) => {
  if (!IS_WIN || healthRunning) return { ok: false, error: healthRunning ? 'Ya en ejecución' : ... };
  healthRunning = true;
  ...
  const runOne = (file, args, label) => new Promise(resolve => {
    let child;
    try { child = spawn(file, args, { windowsHide: true }); }
    ...
    child.on('close', code => { send(`  [exit ${code}]\n`); resolve(code === 0); });
  });
```

- No se guarda la referencia al `child` fuera de `runOne`, así que **no hay forma de
  matarlo**. No existe un handler `cancel-health`, y `preload.js` no expone nada
  parecido.
- No hay timeout. A diferencia de `ps()`, que sí pasa `{ timeout }` a `execFile`
  (`main.js:40`), aquí se usa `spawn` sin límite.
- `healthRunning` sólo vuelve a `false` en `main.js:782`, dentro del `async` que se
  completa cuando `runOne` resuelve — es decir, sólo si `close` o `error` se emiten.
  Si `dism.exe` se queda colgado (le pasa, sobre todo con el almacén de componentes
  corrupto y sin red), no se emite ninguno de los dos.
- En el renderer, `setHealthRunning(false)` sólo ocurre en el callback `onHealthDone`
  (`renderer.jsx:487`) o si el `invoke` devuelve `ok:false` (`:506`). Con un cuelgue,
  ninguna de las dos se dispara.

**Impacto real**

El estado final es: los cuatro botones de reparación deshabilitados
(`renderer.jsx:539-541`), el log parado en la última línea que llegó, un cursor
parpadeando, y ninguna salida. Reabrir la app no ayuda del todo: el `dism.exe`
huérfano sigue vivo en segundo plano tocando el almacén de componentes de Windows, y
el nuevo proceso de la app arranca con `healthRunning = false`, así que permite lanzar
un **segundo** DISM concurrente — que es exactamente lo que no se debe hacer.

Esto es una operación que tarda entre 5 y 40 minutos legítimamente, así que el usuario
no tiene forma de distinguir "va lento" de "está colgado".

**Arreglo propuesto**

1. Guardar el `child` en una variable de módulo y añadir un handler `cancel-health`
   que haga `taskkill /T /PID <pid>` (DISM y SFC crean hijos; `child.kill()` no basta
   en Windows). Exponerlo en `preload.js` y poner un botón CANCELAR en la UI, visible
   sólo mientras corre.
2. Watchdog por inactividad, no por duración total: si no llega ni una línea por
   stdout/stderr en N minutos (10 es razonable para DISM), avisar en la UI y ofrecer
   cancelar. Un timeout duro sobre la duración total cortaría reparaciones legítimas.
3. Liberar `healthRunning` en `finally`, y también si el renderer se recarga o la
   ventana se destruye.
4. Reflejar progreso real: DISM emite porcentajes; parsearlos y mostrar una barra en
   vez de un spinner indeterminado (ver también [B1](#b1)).
5. Detectar al arrancar si ya hay un `dism.exe`/`sfc.exe` en marcha y no permitir
   lanzar otro.

---

# MEDIOS

## M1 — La salida de SFC se decodifica mal, y el parche mete un byte nulo en el código fuente

**Evidencia.** `main.js:766-769`:

```js
const onData = buf => {
  const txt = buf.toString('utf8').replace(/ /g, '').replace(/\r/g, '');
```

Ese `.replace(/ /g,'')` no quita espacios: contiene un **byte NUL (0x00) literal**
dentro del patrón. Verificado — `main.js` tiene exactamente 1 byte nulo en 49.838, y
`grep` clasifica el fichero como binario por su causa (`grep: main.js: binary file
matches`), lo que rompe el grepeado normal del proyecto.

El origen del problema es que `sfc.exe` emite su salida en **UTF-16LE**, no en UTF-8.
Decodificar UTF-16LE como UTF-8 produce un NUL entre cada carácter; el `replace` es un
parche para quitarlos a posteriori.

**Impacto.** Funciona por casualidad para ASCII, pero corrompe cualquier carácter
acentuado (SFC en español dice "Protección de recursos de Windows…"). Además el chunking
de `spawn` puede partir un par de bytes UTF-16 entre dos eventos `data`, produciendo
caracteres basura. Y el NUL en el fuente es una trampa para cualquiera que edite el
fichero.

**Arreglo.** Decodificar explícitamente: acumular los `Buffer` y usar
`new TextDecoder('utf-16le', { stream: true })`, o `iconv-lite`. Detectar la
codificación por comando (`sfc` → UTF-16LE, `dism` → según consola). Eliminar el NUL
del fuente.

## M2 — `create-restore-point` desactiva permanentemente el límite de frecuencia de puntos de restauración

**Evidencia.** `main.js:743-745`:

```powershell
$rp = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore'
if (-not (Test-Path $rp)) { New-Item -Path $rp -Force | Out-Null }
Set-ItemProperty -Path $rp -Name 'SystemRestorePointCreationFrequency' -Value 0 ...
```

Se pone a 0 (sin límite) y **nunca se restaura**. El valor por defecto de Windows son
1440 minutos.

**Impacto.** Es un cambio de política del sistema que sobrevive a la app. A partir de
ahí, cualquier programa que use `Checkpoint-Computer` puede crear puntos ilimitados,
llenando el espacio reservado a Protección del Sistema y **expulsando los puntos
antiguos** — que son precisamente los que el usuario querría para volver a antes de
que empezaran los problemas. Además `Enable-ComputerRestore` (`main.js:742`) puede
activar la protección del sistema en un equipo donde estaba deliberadamente desactivada.

**Arreglo.** Leer el valor previo, ponerlo a 0, crear el punto y **restaurar el valor
original en un `finally`**. Si estaba ausente, eliminar la propiedad al terminar. No
llamar a `Enable-ComputerRestore` sin avisar al usuario de que se va a activar y de
que consume espacio en disco.

## M3 — `network-reset` está expuesto, es destructivo, y no lo llama nadie

**Evidencia.** `main.js:619-631` ejecuta `netsh winsock reset` + `netsh int ip reset`.
`preload.js:46` lo expone como `networkReset`. Grep en `src/renderer.jsx`:
**0 ocurrencias**. Es API muerta.

**Impacto.** Hoy, ninguno: no hay forma de invocarlo desde la UI. El problema es doble.
Primero, prueba que nada verifica el cableado preload ↔ renderer (ver [B7](#b7)).
Segundo, si alguien lo cablea sin leer esto, tiene un handler que resetea la pila de
red completa —descartando configuraciones de winsock que instalan VPNs, antivirus y
clientes corporativos, y exigiendo reinicio— sin confirmación y sin advertencia. Es la
operación más destructiva del proyecto después de las tres críticas.

**Arreglo.** O se elimina el handler y su entrada en `preload.js`, o se cablea con
confirmación explícita ("se perderán configuraciones de red personalizadas, incluidas
las de clientes VPN; requiere reiniciar"), aviso de reinicio y creación previa de un
punto de restauración. Mi recomendación: eliminarlo. `flush-dns` cubre el 95 % del uso
real con el 0 % del riesgo.

## M4 — La segunda instancia no aborta: sigue registrando handlers y puede crear ventana

**Evidencia.** `main.js:9-10`:

```js
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); }
```

`app.quit()` es asíncrono y a nivel de módulo no hay `return` posible, así que la
ejecución continúa: se registran los 29 `ipcMain.handle`, y `app.whenReady().then(...)`
(`main.js:895`) queda encolado. Si el `quit` no ha completado antes de `ready`, se
ejecuta `checkAdmin()`, `createTray()` y `createWindow()`.

**Impacto.** Parpadeo de una segunda ventana e icono duplicado en el tray en el mejor
caso. En el peor, la segunda instancia llega a `main.js:900-904` y —al no ser
administrador— **lanza un `elevate()`**, con lo que el usuario recibe un UAC
inesperado al intentar abrir la app que ya tenía abierta.

**Arreglo.** Envolver toda la inicialización en `if (gotTheLock) { ... }`, o hacer que
`whenReady` compruebe el flag antes de tocar nada:
```js
if (!gotTheLock) { app.quit(); }
else { app.whenReady().then(...) }
```

## M5 — "Liberar RAM" fuerza paginación en todo el sistema y mide mal lo que libera

**Evidencia.** `main.js:452-474` (`free-ram`) y `main.js:792-808` (`optimize-cpu-ram`)
llaman a `EmptyWorkingSet` sobre **todos** los procesos:

```powershell
Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
  try { [void][VokMem]::EmptyWorkingSet($_.Handle); $n++ } catch {}
}
```

La medición, `main.js:454` y `470-471`:

```js
const before = await memAvailable();
...
await new Promise(res => setTimeout(res, 600));
const after = await memAvailable();
const freed = Math.max(0, after - before);
```

**Impacto.** `EmptyWorkingSet` no libera memoria: **la echa al fichero de paginación**.
El resultado inmediato es que "RAM disponible" sube (que es justo lo que la app mide y
presenta como éxito) y el resultado a los pocos segundos es una ráfaga de fallos de
página duros mientras cada proceso vuelve a leer del disco lo que necesitaba. El
sistema queda momentáneamente **más lento**, no más rápido, y en un SSD son escrituras
gratuitas. Aplicado a todos los procesos —incluidos los del sistema— es el
comportamiento clásico de los "RAM boosters" de dudosa reputación.

La medición además es engañosa por construcción: 600 ms de ventana en un sistema vivo
atribuye a la app cualquier variación que hubiera ocurrido igual. Y `Math.max(0, ...)`
garantiza que nunca se muestre un resultado negativo, así que el número siempre "sale
bien". Ese valor se escribe en el historial permanente (`main.js:472`) y se acumula en
"ESPACIO LIBERADO" (`renderer.jsx:592`), mezclado con bytes de disco reales, que son
otra magnitud completamente distinta.

**Arreglo.** Aplica la regla del encargo: *si un tweak no se puede justificar, quítalo*.
Propongo:
1. Limitar `EmptyWorkingSet` a procesos que llevan un rato inactivos y no son del
   sistema, o eliminar la función.
2. Si se mantiene: no presentar el delta de RAM disponible como "liberado". Mostrar
   working set total antes/después, que es lo que de verdad se ha recortado, y decir
   con claridad que la memoria se ha movido al fichero de paginación.
3. No sumar bytes de RAM y bytes de disco en el mismo contador del historial.

## M6 — Scripts PowerShell construidos por interpolación de datos del renderer

**Evidencia.** `main.js:432-437` (`toggle-startup`) y `main.js:705-710`
(`clean-registry`) interpolan valores que vienen del renderer escapando sólo la comilla
simple:

```js
const safeName = (item.approvedName || item.name).replace(/'/g, "''");
...
Set-ItemProperty -Path '${apPath}' -Name '${safeName}' ...
```

**Impacto.** El escape de `''` dentro de una cadena literal de PowerShell es correcto,
así que no hay ejecución de código arbitrario por esta vía. Pero el patrón es frágil:
cualquier añadido futuro que interpole en un contexto distinto (una cadena con comillas
dobles, una expresión, un `-Path` sin comillas) se convierte en inyección, y no hay
nada que lo impida. El caso de `clean-registry` ya demuestra el fallo real de este
enfoque: el dato pasa la validación de sintaxis pero es semánticamente peligroso
([C2](#c2)).

**Arreglo.** Pasar los datos **fuera del script**, no dentro: serializar los parámetros
a JSON y entregarlos por stdin, con el script leyéndolos vía
`[Console]::In.ReadToEnd() | ConvertFrom-Json`. El script pasa a ser constante y los
datos nunca son código. Esta decisión va junto con la de A2.3 (proceso persistente) y
la contrastamos en la Fase 2.

## M7 — La caché de navegadores sólo cubre el perfil `Default` de Chrome/Edge

**Evidencia.** `main.js:228-232`: rutas fijas a
`...\Chrome\User Data\Default\Cache`, `Default\Code Cache` y los equivalentes de Edge.
Ignora `Profile 1`, `Profile 2`, … y `Guest Profile`.

Nota sobre Firefox: la ruta usada, `%LOCALAPPDATA%\Mozilla\Firefox\Profiles`, es la de
**caché**, no la del perfil real (que está en `%APPDATA%\Mozilla\Firefox\Profiles` y
contiene marcadores, contraseñas y cookies). Comprobé que no hay Firefox instalado en
esta máquina para verificarlo empíricamente, pero la ruta es correcta: borrar ahí no
destruye datos del usuario. Aun así, el borrado recursivo de directorios
(`main.js:303-305`) elimina también `startupCache` y `safebrowsing`, lo que hace el
siguiente arranque de Firefox notablemente más lento — coste que la UI no menciona.

**Impacto.** Subestima el espacio recuperable en cualquier equipo con más de un perfil
de navegador (habitual: trabajo + personal), que es justo donde hay más caché.

**Arreglo.** Enumerar los directorios de perfil con un glob
(`User Data\*\Cache`, `User Data\*\Code Cache`) en lugar de fijar `Default`. Añadir
Brave, Opera y Vivaldi, que comparten el layout de Chromium. Y avisar de que la
limpieza con el navegador abierto puede no completarse.

## M8 — Borrar la caché de Windows Update con el servicio en marcha

**Evidencia.** `main.js:236` → `"$env:SystemRoot\SoftwareDistribution\Download"`,
catalogado `REVISAR` (`main.js:216`). El borrado no detiene `wuauserv` antes.

**Impacto.** Si hay una actualización descargándose o pendiente de instalar, se borra a
medias. Windows Update lo suele detectar y volver a descargar (coste: ancho de banda y
tiempo), pero puede quedar en un estado que requiera
`DISM /Cleanup-Image /StartComponentCleanup` para arreglarse. La etiqueta `REVISAR`
avisa, pero la UI no explica qué hay que revisar.

**Arreglo.** Detener `wuauserv` y `bits`, borrar, rearrancarlos. Y detectar si hay una
actualización en curso (`Get-WindowsUpdateLog` es caro; basta comprobar el estado del
servicio y la presencia de `.esd`/`.cab` recientes) para desaconsejar la operación en
ese momento.

## M9 — `sandbox: false` en el renderer

**Evidencia.** `main.js:845`: `nodeIntegration: false, contextIsolation: true, sandbox: false`.

**Impacto.** Bajo en la práctica: el renderer sólo carga contenido local
(`loadFile`), la CSP es estricta (`index.html:6`), no hay `nodeIntegration` y
`setWindowOpenHandler` deniega ventanas nuevas (`main.js:857`). El sandbox sería una
capa más de defensa en profundidad para un proceso que, si se compromete, habla con un
main process elevado.

**Arreglo.** Poner `sandbox: true`. El `preload.js` actual sólo usa
`contextBridge` e `ipcRenderer`, ambos disponibles en preloads sandboxeados, así que
debería funcionar sin cambios. Verificar tras el cambio.

## M10 — Confirmaciones que faltan {#m10}

**Evidencia.** Confirmaciones que **sí** existen: servicios marcados como no seguros
(`renderer.jsx:357`), finalizar proceso (`:440`), limpiar registro (`:498`), borrar
historial (`:593`). Faltan en:

| Operación | Sitio | Por qué importa |
|-----------|-------|-----------------|
| `clean-junk` (todas las categorías) | `renderer.jsx:306-317` | Incluye papelera ([C1](#c1)) y `%TEMP%` ([C3](#c3)) |
| Limpieza rápida (dashboard) | `renderer.jsx:217` | Un clic, sin diálogo, borra temp + cachés |
| "OPTIMIZAR SISTEMA" | `renderer.jsx:750` | Ídem, y es el botón más grande de la app |
| `toggle-startup` | `renderer.jsx:396` | Reversible, así que basta con deshacer |
| Cambio de `startMode` de servicio "safe" | `renderer.jsx:375` | El `<select>` aplica al instante; un scroll con el ratón encima cambia el valor |
| `apply-profile` | `renderer.jsx:144` | Modifica el registro y detiene servicios sin avisar |

**Arreglo.** Un componente de confirmación propio (no `window.confirm`, que rompe la
estética y bloquea el proceso de renderizado) con el lenguaje visual actual: fondo
negro, borde de 1,5 px, mayúsculas con letter-spacing. Escalar la fricción al daño:

- **Irreversible** (papelera, registro, `%TEMP%`): confirmación con detalle de lo que
  se pierde y volumen.
- **Reversible pero intrusivo** (perfiles, servicios): banner con "DESHACER" durante
  unos segundos, sin diálogo previo.
- **Trivialmente reversible** (arranque): nada, sólo el cambio de estado, que ya se ve.

Para el `<select>` de servicios: `onChange` no debe aplicar directamente; requiere un
botón APLICAR o un `onBlur`.

## M11 — `useAsync` captura `fn` de la primera renderización y descarta errores

**Evidencia.** `renderer.jsx:35-40`:

```js
function useAsync(fn){
  const [st,setSt]=useState({loading:true,data:null});
  const run=useCallback(()=>{...Promise.resolve(fn()).then(...).catch(()=>setSt({loading:false,data:null}));},[]);
```

`fn` no está en las dependencias del `useCallback`, así que `run` queda cerrado sobre
la `fn` de la primera renderización. Todos los usos actuales pasan una lambda sin
dependencias externas (`()=>api.listServices()`), así que hoy funciona; es una bomba de
relojería para el primer uso que capture props o estado. El `.catch` vacío es el
problema de [A5](#a5) en el renderer.

**Arreglo.** Guardar `fn` en un `useRef` actualizado en cada render y llamar a
`ref.current()`. Añadir `error` al estado y devolverlo.

## Nota sobre `scan-registry` {#nota-scan-registry}

El encargo sospechaba de una heurística por substring. No hay tal cosa: el escáner
comprueba **existencia real de rutas** con `Test-Path` en tres categorías
(`main.js:641-691`), que es un criterio sólido. Dicho eso, tiene dos falsos positivos
previsibles que conviene endurecer ahora que se está mirando:

- `InstallLocation` en un volumen desmontado (unidad USB, red, disco externo) → se
  reporta como huérfana aunque el programa exista. `main.js:653` sólo comprueba
  `$loc.Length -gt 3` y `Test-Path`. **Arreglo:** verificar que la raíz del volumen
  está montada antes de juzgar, y excluir rutas UNC y unidades de red.
- Entradas de `Run` cuyo comando no es una ruta directa (`rundll32`, `cmd /c`,
  `powershell -File`, rutas sin extensión) → el regex de `main.js:682-683` puede
  extraer un `.exe` que no es el objetivo real. **Arreglo:** no reportar cuando el
  comando empiece por un intérprete conocido.

Ambos son severidad **media**: producen una sugerencia de borrado incorrecta, pero hay
confirmación y backup (una vez arreglado [C2](#c2)), así que no llegan a pérdida de
datos.

---

# BAJOS

## B1 — Escaneos sin progreso, sin tiempo estimado y sin cancelación {#b1}

`scan-junk` tiene 60 s de timeout (`main.js:270`) y `clean-junk` 120 s
(`main.js:311`), pero la UI sólo muestra una barra indeterminada
(`renderer.jsx:322-325`) y no hay forma de cancelar. Si el timeout se cumple, `ps()`
mata el proceso y devuelve `stdout` vacío → [A5](#a5) → "Sistema limpio".

**Arreglo.** Emitir progreso por categoría desde PowerShell (una línea por categoría
terminada) y mostrarlo. Botón CANCELAR que mate el proceso. Y que el timeout se
comunique como timeout, no como "no hay nada".

## B2 — La puntuación del dashboard es arbitraria y se falsea tras optimizar

`renderer.jsx:213`:
```js
const score=optimized?94:Math.max(1,Math.round(100-(cpu*.28+ram.pct*.22+(ext.gpu>0?ext.gpu:0)*.12)*.35));
```
Con carga 0 en todo da 100; el `optimized?94` fija un 94 después de optimizar
independientemente del estado real. Es un número inventado presentado con la autoridad
de una medición, en una app cuyo README insiste en que *"todos los datos son reales"*.

**Arreglo.** O se define la puntuación a partir de algo verificable (nº de servicios
innecesarios activos, programas de arranque, espacio recuperable, entradas huérfanas) y
se explica su composición al pasar el ratón, o se sustituye por métricas directas sin
agregado.

## B3 — Handlers IPC sin validación de origen

Ningún `ipcMain.handle` comprueba `event.senderFrame`. Riesgo bajo (sólo se carga
contenido local con CSP estricta), pero es una línea por handler y estos handlers
ejecutan operaciones privilegiadas.

**Arreglo.** Un wrapper `handle(name, fn)` que valide que el sender es la ventana
principal antes de delegar. Reduce además la repetición de `if (!IS_WIN) return`.

## B4 — El historial no registra fallos

`addHistory` sólo se llama en las rutas de éxito. `main.js:373` (servicio),
`main.js:441` (arranque) y `main.js:750` (punto de restauración) registran únicamente
cuando la operación fue bien; los `return { ok:false }` no dejan traza. El campo
`status` existe (`main.js:61`) y sólo se usa con `'WARN'` en dos sitios.

**Arreglo.** Registrar también los fallos con `status:'ERROR'` y el mensaje. Un
historial que sólo tiene éxitos no sirve para diagnosticar.

## B5 — Versión duplicada en tres sitios

`package.json` dice `4.2.0`; `preload.js:5` repite `version: '4.2.0'` a mano;
`renderer.jsx:656` la escribe otra vez como literal (`v4.2.0 · System Optimizer`).
Tres fuentes de verdad que se desincronizarán.

**Arreglo.** `app.getVersion()` en el main, pasarla al renderer por IPC o por
`define` de esbuild.

## B6 — README desactualizado

`README.md:1` anuncia v4.0.0 y las rutas de build de `:45-46` citan
`Vokoptimizer-4.0.0-Setup.exe`, mientras `package.json` está en 4.2.0 y `dist/`
contiene los artefactos 4.2.0. La sección "Seguridad y reversibilidad" (`:66-71`)
afirma cosas que esta auditoría contradice: *"La limpieza solo toca rutas de
caché/temporales conocidas"* (cierto pero incompleto: también la papelera) y
*"Antes de eliminar entradas del registro se exporta un backup"* (no garantizado,
[C2](#c2)).

**Arreglo.** Actualizar tras la Fase 3, cuando las afirmaciones sean ciertas.

## B7 — No hay nada que verifique el cableado UI ↔ preload ↔ main {#b7}

Los validadores que menciona el encargo (`validate.js`, `check-api.js`) no existen en
este proyecto. La única comprobación es que esbuild compile. Prueba de que hace falta:
`networkReset` está expuesto y muerto ([M3](#m3)), y nadie lo había detectado.

**Arreglo.** Dos scripts pequeños, ejecutables en `npm run check`:
1. **Coherencia de API:** extraer los nombres de `ipcMain.handle` de `main.js`, los
   `ipcRenderer.invoke` de `preload.js` y los `api.X` de `renderer.jsx`; fallar si hay
   un handler sin puente, un puente sin handler, un puente sin uso, o un uso sin
   puente.
2. **Reglas de seguridad:** fallar si aparece `Remove-Item -Recurse -Force` con una
   ruta interpolada sin whitelist, si un handler destructivo nuevo no está en la lista
   de "requiere confirmación", o si hay bytes NUL en el fuente ([M1](#m1)).

Con eso, las clases de error de este informe no vuelven a entrar sin avisar.

## B8 — El proyecto no está bajo control de versiones

No hay `.git` en `C:\Users\enolp\vokoptimizer`. Tampoco copias de seguridad del código.

**Arreglo.** `git init`, `.gitignore` (ya existe, con `app.bundle.js` y
`node_modules`), commit del estado actual **antes** de empezar la Fase 3. No es
burocracia: vamos a modificar código que ejecuta borrados recursivos como
administrador.

---

## Lo que está bien y no hay que tocar

Para no perderlo de vista durante la Fase 3:

- **Ejecución de PowerShell vía `-EncodedCommand`** (`main.js:34-44`): correcto, con
  `-NoProfile -NonInteractive`, timeout, `windowsHide` y `maxBuffer` generoso. Evita
  el infierno de comillas y no escribe `.ps1` temporales.
- **Renderer precompilado con esbuild** y CSP sin `unsafe-eval` (`index.html:6`):
  es la solución correcta al problema 9 del encargo, ya aplicada.
- **`toggle-startup` vía `StartupApproved`** (`main.js:424-443`): usa el mismo
  mecanismo que el Administrador de tareas, así que es reversible de verdad y
  compatible con la UI de Windows. Es el mejor handler del proyecto.
- **Whitelist de servicios** (`main.js:364`): `set-service` rechaza cualquier nombre
  fuera de `SVC_META`. Es exactamente la defensa que le falta a `clean-registry`
  ([C2](#c2)) — el patrón ya existe en el código, sólo hay que replicarlo.
- **`applyProfile` devuelve el resultado paso a paso** (`main.js:524-601`) y la UI lo
  muestra con estados de progreso: buen diseño, y la base sobre la que construir el
  reporte de errores de [A5](#a5).
- **La estética**: terminal en blanco y negro, JetBrains Mono empaquetada localmente,
  bordes de 1,5 px, mayúsculas con letter-spacing, animaciones con `cubic-bezier` y
  canvas. Coherente y con carácter. Todo lo que propongo en materia de UI
  (confirmaciones, estados de error, progreso) va dentro de este lenguaje, no encima.

---

## Siguiente paso

Fase 2: contrastar contigo el plan antes de tocar código, con tres decisiones
arquitectónicas abiertas que conviene no resolver a solas —

1. **Cómo ejecutar PowerShell**: seguir con un proceso por llamada (simple, 160 ms de
   penalización cada vez) o pasar a un proceso persistente con parámetros por stdin
   (rápido y elimina la interpolación de [M6](#m6), pero hay que gestionar ciclo de
   vida y framing).
2. **Qué hacer con las operaciones que no se pueden revertir de forma fiable**:
   `PROCTHROTTLE*` ([A4](#a4)), `EmptyWorkingSet` ([M5](#m5)) y `network-reset`
   ([M3](#m3)) son candidatas a desaparecer en vez de a arreglarse.
3. **Cómo estructurar el renderer**: 787 líneas en un fichero con líneas de más de
   2000 caracteres es mantenible hoy y no lo será tras añadir estados de error,
   confirmaciones y cancelación a cada panel.

Y una pregunta que hay que responder antes de todo: **¿existe la v3 que describe el
encargo?** Si sí, la audito; si no, este informe es el plan.
