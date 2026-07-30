# PLAN — Remediación de Vokoptimizer v4.2.0

**STATUS: APPROVED**

Base: `AUDIT.md` (3 críticos, 7 altos, 11 medios, 8 bajos).
Commit de partida: `27a2479` "estado previo a la auditoría".

Para revisar: añade notas inline en este fichero con los prefijos `TODO:`, `FIXME:` o
`Q:` y las incorporo. Cuando esté conforme, cambia `STATUS` a `APPROVED`.

---

## Decisiones cerradas en la Fase 2

| # | Decisión | Consecuencia |
|---|----------|--------------|
| 1 | **Público: solo tú y gente cercana** | Los 3 críticos siguen siendo bugs que se arreglan (la papelera de un amigo es datos reales), pero no se construyen defensas contra un renderer hostil: las validaciones se hacen por robustez, no por modelo de amenaza |
| 2 | **GPU en tiempo real a 2 s, con proceso por llamada + filtro `engtype_3D`** | Se descarta el proceso PowerShell persistente y toda su infraestructura (protocolo, heartbeat, reinicio, fallback). ~660 ms por poll frente a 2150 ms |
| 3 | **Arreglar los tres tweaks, no eliminar ninguno** | `network-reset` se cablea con confirmación dura (UI nueva en Mantenimiento); el cap de CPU se hace reversible de verdad; "Liberar RAM" se acota y se mide con honestidad |
| 4 | **Verificación al final, de una pasada** | Un commit por tanda para que puedas bisecar; defensiva extra en todo lo que no puedo probar; validadores estáticos que cubran lo que no se puede cubrir ejecutando |
| 5 | **Renderer híbrido** | Los paneles no se mueven de `renderer.jsx`; solo se editan las líneas que cambian. Lo nuevo y compartido va a `src/ui/` y `src/lib/`, escrito legible |
| 6 | **Alcance: críticos + altos + medios adyacentes** | Entran: C1-C3, A1-A7, M1-M7, M10, M11, B4, B7. Quedan fuera: M8, M9, B1, B2, B3, B5, B6, B8 |

## Hallazgo nuevo, aparecido durante la Fase 2

**N1 — La utilización de GPU puede superar el 100 % y se pinta sin límite.**
`main.js:118` suma `CookedValue` de **todas** las instancias de `GPU Engine`, y un mismo
proceso usa varios motores a la vez (3D, Copy, Timer, VideoEncode). Medido en tu
equipo: 369 instancias, de las cuales 119 son `engtype_3D`. El Administrador de tareas
de Windows no suma motores. En `renderer.jsx:564` el valor se pinta crudo, así que
puede mostrar "312 %"; en `renderer.jsx:244` la barra sí se clampa dentro de
`BarGlyph`, pero el `pct` calculado no. Severidad **media**. Se arregla dentro de A2.

Se añadirá a `AUDIT.md` al cerrar la implementación.

---

## Tanda 1 — Nada puede dañar el sistema ni perder datos

`main.js`, `src/renderer.jsx`, `src/ui/confirm.jsx` (nuevo).
Commit: `fix(seguridad): confirmaciones duras, whitelist de registro y limpieza acotada de TEMP`

### 1.1 · C1 — Papelera de reciclaje

- `main.js:207-218` — nueva propiedad en `JUNK_CATS`: `irreversible: true` para
  `recycle`, y `risk: 'IRREVERSIBLE'`.
- `main.js` (`scan-junk`) — devolver `irreversible` en el objeto de cada categoría para
  que la UI pueda decidir sin duplicar la lista.
- `src/renderer.jsx` (`FileCleaner`) — la fila de una categoría irreversible se pinta
  con el tratamiento de mayor peso del lenguaje visual actual (borde `1.5px` en blanco
  en vez de `#262626`, etiqueta en mayúsculas con letter-spacing). No se preselecciona
  nunca.
- `clean()` — si la selección contiene alguna categoría irreversible, abrir el diálogo
  de confirmación con el detalle: nombre, número de elementos y volumen, más la frase
  "Esto no se puede deshacer". Sin ella, no se llama a `cleanJunk`.
- Verificar por código que `recycle` no está en `renderer.jsx:217` (acción rápida) ni
  en `handleOpt` (`renderer.jsx:750`), y dejar un comentario que lo fije.

**Aceptación:** imposible vaciar la papelera sin haber leído un diálogo que diga cuánto
se pierde. Ningún camino de un clic la incluye.

### 1.2 · C2 — `clean-registry`

- `main.js` — constante nueva `ALLOWED_REG_PREFIXES` con los seis prefijos exactos que
  `scan-registry` puede producir (`main.js:642-646`, `661`, `675`).
- Guardar en memoria el resultado del último `scan-registry` (`lastRegistryScan`) y
  aceptar en `clean-registry` **solo** ítems presentes en él, comparando `key` +
  `valueName`. Si `lastRegistryScan` está vacío, rechazar la operación entera.
- Validación por ítem, en este orden: (1) está en el último escaneo; (2) encaja con un
  prefijo permitido; (3) no contiene `..`; (4) no es exactamente igual a un prefijo
  (solo subclaves); (5) para las dos rutas `Run`, exigir `valueName` — ahí se borra un
  valor, nunca la clave.
- Backup bloqueante: comprobar `$LASTEXITCODE` de `reg export` **y** que el `.reg`
  existe con longitud > 0. Si falla, **no borrar** ese ítem y devolverlo en `skipped`
  con el motivo.
- Devolver `{ ok, done, total, skipped: [...], errors: [...], backup }`.
- `src/renderer.jsx` (`RegistryCleaner.clean`) — mostrar `skipped` y `errors`
  explícitamente en lugar del toast genérico. Las entradas omitidas se quedan en la
  lista, marcadas.

**Aceptación:** con `items` manipulado a mano, el handler rechaza y explica. Ninguna
clave se borra sin un `.reg` verificado en disco. La UI nunca dice "backup guardado"
sin que exista.

### 1.3 · C3 — `%TEMP%`

- `main.js:224` — `'temp_user' { return @($env:TEMP) }`. Se elimina la ruta duplicada
  (esto es también [A1](#a1)).
- Deduplicación general en el recorrido de rutas: resolver cada ruta a su forma
  canónica y aplicar `Select-Object -Unique` antes de recorrerla, para que ninguna
  categoría futura pueda contar dos veces.
- Política de antigüedad: solo se borra lo anterior a **24 h**
  (`$_.LastWriteTime -lt (Get-Date).AddHours(-24)`), aplicada a `temp_user` y
  `temp_win`. El resto de categorías (cachés, WER, dumps) no la necesitan.
- Exclusión incondicional del directorio de ejecución propio. Node calcula
  `[path.dirname(process.execPath), __dirname, app.getPath('temp')]` más
  `PORTABLE_EXECUTABLE_FILE` si existe, y lo pasa como parámetro; PowerShell descarta
  cualquier `FullName` que empiece por uno de ellos. **Imprescindible para el build
  portable, que se extrae dentro de `%TEMP%`.**
- Los directorios ya no se borran recursivamente a ciegas: solo se eliminan los que
  quedan vacíos tras la pasada de ficheros.
- El escaneo aplica exactamente el mismo filtro que la limpieza, para que el tamaño
  mostrado sea el que de verdad se va a liberar.

**Aceptación:** ejecutar la limpieza desde el portable no puede borrar los ficheros de
la propia app. Un instalador que descomprimió hace diez minutos sobrevive.

### 1.4 · A6 — Procesos protegidos

- `main.js` — `PROTECTED_PROCESSES` (Set de nombres en minúsculas): `system`,
  `memory compression`, `registry`, `smss`, `csrss`, `wininit`, `winlogon`,
  `services`, `lsass`, `lsaiso`, `svchost`, `fontdrvhost`, `dwm`, `sihost`,
  `msmpeng`, `securityhealthservice`, `explorer`, `vokoptimizer`.
- `kill-process` — rechazar PID 0 y 4 siempre; resolver el nombre del PID antes de
  matar y rechazar si está en la lista, devolviendo un error que lo explique.
- `get-metrics` — marcar cada proceso de `topProcs` con `protected: true/false`.
- `src/renderer.jsx:463-468` — los protegidos no muestran botón ✕, sino una etiqueta
  `PROTEGIDO` en el estilo de las etiquetas de riesgo.
- Para los no protegidos, la confirmación advierte de pérdida de datos sin guardar.

**Aceptación:** ningún camino de la UI permite matar un proceso crítico. La lista se
comprueba en el main process, no solo en la UI.

### 1.5 · M10 (parte crítica) — Componente de confirmación

- Nuevo `src/ui/confirm.jsx`: función `confirmDialog({ title, lines, detail, danger })`
  que devuelve `Promise<boolean>`, más el componente que la renderiza.
- Estética: fondo `#000`, borde `1.5px`, título en mayúsculas con `letter-spacing`,
  JetBrains Mono, botones con el patrón `btn-pri` / `btn-ghost` ya existente. Sin
  `window.confirm` (bloquea el renderizado y rompe la estética).
- Accesibilidad e interacción: foco atrapado dentro del diálogo, foco inicial en el
  botón **seguro** (no en el destructivo), `Escape` cancela, `Enter` confirma solo si
  el foco está en el botón de confirmar, y el foco vuelve al elemento que lo abrió.
- Se reemplazan los cuatro `window.confirm` existentes (`renderer.jsx:357`, `:440`,
  `:498`, `:593`) por este componente, sin cambiar su lógica.

---

## Tanda 2 — Ninguna operación falla en silencio

`main.js`, `src/renderer.jsx`, `src/ui/panel-state.jsx` (nuevo), `src/lib/use-async.js` (nuevo).
Commit: `fix(errores): distinguir vacio de fallo en todas las consultas al sistema`

### 2.1 · A5 — Contrato de `psJson`

- `main.js:45-49` — `psJson` pasa a devolver
  `{ ok: true, data } | { ok: false, error, kind }` con
  `kind ∈ 'timeout' | 'spawn' | 'stderr' | 'parse' | 'empty'`.
  Se considera fallo: `r.err` presente (incluido `err.killed` por timeout), `stdout`
  vacío con `stderr` no vacío, y `JSON.parse` que lanza. Un `stdout` vacío **sin**
  `stderr` y con código 0 es un vacío legítimo.
- Los cinco handlers afectados (`scan-junk`, `list-services`, `list-startup`,
  `scan-registry`, `clean-junk`) devuelven `{ ok:false, error }` en vez de aplanar
  a `[]` o a `{ok:true}`.
- `clean-junk` deja de devolver `{ok:true}` incondicionalmente
  (`main.js:311-314`): reporta por categoría bytes liberados, ficheros omitidos y
  motivo, y `ok:false` si el script falló.

### 2.2 · Tres estados en la UI

- Nuevo `src/ui/panel-state.jsx` con un componente que cubre los tres casos:
  **cargando** (spinner + etiqueta, como el `Loading` actual), **vacío legítimo**
  (el texto que ya existe hoy en cada panel, sin cambios) y **falló** (motivo,
  distinción visual de error coherente con los toasts, y botón REINTENTAR).
- Se aplica en los cuatro paneles que hoy mienten: `FileCleaner` (`renderer.jsx:341`),
  `Services` (`:365`), `StartupManager` (`:417`), `RegistryCleaner` (`:525`).

### 2.3 · M11 y B4

- `src/lib/use-async.js` — `useAsync` con `fn` en un `useRef` actualizado en cada
  render (hoy queda capturado en la primera, `renderer.jsx:37`), y `error` en el
  estado en lugar de descartado.
- `addHistory` se llama también en las rutas de fallo, con `status: 'ERROR'` y el
  mensaje. Afecta a `set-service`, `toggle-startup`, `create-restore-point`,
  `clean-junk`, `clean-registry`.
- `renderer.jsx:606` — pintar el estado `ERROR` distinguible de `WARN`.

**Aceptación:** con PowerShell fallando, ningún panel dice "limpio", "no hay" ni
muestra un check verde. Todos dicen qué falló y ofrecen reintentar. El historial
contiene los fallos.

---

## Tanda 3 — El optimizador deja de consumir CPU

`main.js`, `src/renderer.jsx`.
Commit: `perf(metricas): GPU via engtype_3D, sin solapamiento de procesos, pausa en bandeja`

### 3.1 · A2 + N1 — Coste de `get-metrics`

- `main.js:114-127` (`gpuTempThreads`) — sustituir `Get-Counter` por
  `PerformanceCounterCategory('GPU Engine')` filtrando instancias `*engtype_3D*`
  (119 de 369 en tu equipo), primar con `NextValue()`, esperar 300 ms dentro del mismo
  proceso, y volver a leer. Medido: 112 ms de creación + 86 ms de lectura.
- Corregir la agregación: en vez de sumar todos los motores, sumar solo `engtype_3D` y
  **clampar a 100** en el main process. Elimina el "312 %" de N1.
- Cachear lo que no cambia cada 2 s: `si.fsSize()` a 30 s, `si.time()` (uptime) a 60 s.
- Presupuesto objetivo del handler: **< 800 ms**, frente a los ~2250 ms actuales.

### 3.2 · Bucle de polling

- `src/renderer.jsx:70-80` (`useSystemMetrics`) — `setTimeout` recursivo en lugar de
  `setInterval`, con guard de petición en vuelo: no se lanza un poll si el anterior no
  ha resuelto, y el periodo cuenta desde que terminó el anterior. Imposible el
  solapamiento aunque una lectura se dispare a 5 s.
- Pausa cuando la ventana no está visible: `mainWindow.on('hide'|'minimize')` y
  `'show'|'restore'` emiten un evento al renderer (nueva entrada en `preload.js`), y
  el hook deja de pollear. Con la app en la bandeja, coste cero.
- `MonitorPanel` (`renderer.jsx:557`) — el `useEffect` depende de valores primitivos,
  no del objeto `metrics` recreado en cada poll, para que el histórico de 60 puntos
  represente 60 lecturas reales.

### 3.3 · M6 — Parámetros por stdin

- `main.js` — nueva variante `psJsonWithInput(script, params, opts)`: el script es una
  constante sin interpolación y los datos van como JSON por stdin, leídos con
  `[Console]::In.ReadToEnd() | ConvertFrom-Json`. **Verificado que funciona con
  `-EncodedCommand`** durante la Fase 2.
- Migrar a esta variante los tres sitios que hoy interpolan datos del renderer:
  `clean-junk` (ids + rutas de exclusión), `toggle-startup` (`main.js:432-437`),
  `clean-registry` (`main.js:705-710`).
- Leer `stderr` por separado de `stdout` en todos los casos: la Fase 2 confirmó que
  PowerShell escribe `#< CLIXML … Preparando módulos para el primer uso` por stderr, y
  mezclarlo rompería el parseo de JSON.

**Aceptación:** ningún script PowerShell se construye concatenando datos que vienen del
renderer. `get-metrics` baja de 2250 ms a menos de 800 ms y nunca hay dos pollings
vivos. En la bandeja, la app no lanza procesos.

---

## Tanda 4 — Todo es reversible, todo se puede cancelar

`main.js`, `src/renderer.jsx`.
Commit: `fix(perfiles): reversion completa, planes de energia idempotentes, cancelacion de SFC/DISM`

### 4.1 · A3 — `duplicatescheme` idempotente

- Función única `ensureUltimateScheme()` que reemplaza los dos fragmentos duplicados
  (`main.js:504-508` y `:576-582`): primero `powercfg /list` para localizar un plan
  Ultimate existente y reutilizar su GUID; solo duplicar si no hay ninguno.
- El GUID del plan creado por la app se guarda en `vok-settings.json` (validando que
  siga existiendo en arranques posteriores).
- El perfil "Equilibrado" borra los duplicados **creados por la app** y registrados en
  settings, nunca planes del usuario.

### 4.2 · A4 — Reversión del cap de CPU

- Antes de escribir, leer y guardar en `vok-settings.json` los valores previos de
  `PROCTHROTTLEMAX` / `PROCTHROTTLEMIN` del plan afectado.
- Escribir con **GUID de plan explícito**, no con `scheme_current`, para saber siempre
  sobre qué plan se opera.
- Aplicar a corriente **y** batería (`-setacvalueindex` y `-setdcvalueindex`): el perfil
  promete "batería al máximo" y hoy no toca los valores de batería.
- "Equilibrado" restaura todo lo que aplican los otros tres perfiles:
  `PROCTHROTTLEMAX`, `PROCTHROTTLEMIN` y la suspensión selectiva de USB, usando los
  valores guardados, y los de fábrica si no hay nada guardado.
- Los pasos de "Equilibrado" se amplían en `renderer.jsx:137` para que la lista de
  acciones que ve el usuario refleje lo que de verdad se restaura.

### 4.3 · A7 — Cancelación de SFC/DISM

- Guardar el `child` en una variable de módulo. Nuevo handler `cancel-health` que
  ejecuta `taskkill /T /F /PID <pid>` (DISM y SFC crean hijos; `child.kill()` no basta
  en Windows). Nueva entrada en `preload.js`.
- Botón CANCELAR en la UI, visible solo mientras corre.
- Watchdog **por inactividad, no por duración total** (una reparación legítima tarda
  entre 5 y 40 minutos): si no llega ninguna línea por stdout/stderr en 10 minutos,
  avisar en el log y ofrecer cancelar.
- `healthRunning` se libera en `finally`, y también si el renderer se recarga o la
  ventana se destruye.
- Al arrancar, detectar si ya hay un `dism.exe`/`sfc.exe` en marcha y no permitir
  lanzar otro.
- Parsear el porcentaje que emite DISM y mostrar progreso real en vez de un spinner
  indeterminado.

### 4.4 · M2 — Punto de restauración

- Leer `SystemRestorePointCreationFrequency`, ponerlo a 0, crear el punto y
  **restaurar el valor original en un `finally`**. Si la propiedad no existía,
  eliminarla al terminar.
- No llamar a `Enable-ComputerRestore` sin avisar: si la protección del sistema está
  desactivada, pedir confirmación explicando que se va a activar y que consume disco.

### 4.5 · M3 — `network-reset` cableado

- Se mantiene el handler y se le añade UI en **Mantenimiento**, junto a SFC/DISM (no en
  las acciones rápidas del dashboard).
- Confirmación dura antes de ejecutar: se perderán configuraciones de winsock
  instaladas por VPN y antivirus, y hace falta reiniciar.
- Crear un punto de restauración antes, y avisar del reinicio pendiente al terminar.

### 4.6 · M5 — "Liberar RAM" honesto

- `EmptyWorkingSet` se limita a procesos que no son del sistema (reutilizando
  `PROTECTED_PROCESSES` de 1.4) y que llevan un rato sin actividad de CPU.
- La métrica deja de ser el delta de RAM disponible en 600 ms: se reporta el working
  set total antes/después, que es lo que de verdad se recorta.
- El texto de la UI dice con claridad que la memoria se mueve al fichero de
  paginación, no que se libera.
- El historial deja de sumar bytes de RAM en el mismo contador que bytes de disco:
  campo separado, y "ESPACIO LIBERADO" (`renderer.jsx:592`) solo cuenta disco.

**Aceptación:** aplicar Trabajo → Equilibrado deja el equipo exactamente como estaba.
Pulsar Máximo Rendimiento diez veces no crea diez planes. SFC/DISM se pueden abortar.

---

## Tanda 5 — Pulido y red de seguridad

`main.js`, `src/renderer.jsx`, `scripts/check-api.js` (nuevo), `scripts/validate.js` (nuevo), `package.json`.
Commit: `chore(calidad): decodificacion UTF-16 de SFC, instancia unica, validadores estaticos`

### 5.1 · M1 — Decodificación de SFC

- Sustituir `buf.toString('utf8').replace(/\0/g,'')` por un decodificador explícito
  `new TextDecoder('utf-16le', { stream: true })` por stream, que además resiste que un
  par de bytes UTF-16 se parta entre dos eventos `data`.
- **Eliminar el byte NUL literal del fuente** (`main.js:767`), que hoy hace que `grep`
  trate `main.js` como binario.
- Los acentos de la salida de SFC en español dejan de salir corruptos.

### 5.2 · M4 — Instancia única

- Envolver la inicialización en `if (gotTheLock) { … }` para que la segunda instancia
  no registre handlers ni llegue a `whenReady` — hoy puede crear ventana y, peor,
  lanzar un `elevate()` que muestra un UAC inesperado.

### 5.3 · M7 — Perfiles de navegador

- Enumerar perfiles con glob (`User Data\*\Cache`, `User Data\*\Code Cache`) en lugar
  de fijar `Default`, para no subestimar el espacio en equipos con varios perfiles.
- Añadir Brave, Opera y Vivaldi, que comparten el layout de Chromium.
- Avisar de que la limpieza con el navegador abierto puede no completarse.

### 5.4 · M10 (resto) — Fricción proporcional al daño

- **Irreversible** (papelera, registro, `%TEMP%`, reset de red): diálogo con detalle.
  Ya cubierto en las tandas 1 y 4.
- **Reversible pero intrusivo** (perfiles, servicios): sin diálogo previo, pero banner
  con DESHACER durante unos segundos tras aplicar.
- **Trivialmente reversible** (arranque): nada, el cambio de estado ya se ve.
- El `<select>` de tipo de inicio (`renderer.jsx:375`) deja de aplicar en `onChange`
  —un scroll con el ratón encima cambia hoy el valor— y requiere confirmación al
  soltar.

### 5.5 · B7 — Validadores

`scripts/check-api.js`: extrae los nombres de `ipcMain.handle` de `main.js`, los
`ipcRenderer.invoke` de `preload.js` y los `api.X` usados en el renderer, y falla si
hay un handler sin puente, un puente sin handler, un puente sin uso, o un uso sin
puente. Detecta hoy `networkReset` (M3) y evita que se repita.

`scripts/validate.js`: compila el renderer y aplica reglas estáticas —

1. Ningún byte NUL en los fuentes (M1).
2. Ningún `Remove-Item -Recurse -Force` con ruta interpolada desde variables JS.
3. Todo handler cuyo nombre encaje con `clean|clear|kill|reset|delete|remove` debe
   estar declarado en una lista de "requiere confirmación", y su llamada en el renderer
   debe pasar por `confirmDialog`.
4. Ninguna ruta de `PS_JUNK_PATHS` puede repetirse tras expandir variables de entorno
   conocidas (A1).

`package.json`: `"check": "node esbuild.config.js && node scripts/validate.js && node scripts/check-api.js"`.

> Nota sobre el encargo: mandabas ejecutar `node build-html.js && node validate.js &&
> node check-api.js`. Esos tres ficheros no existen en este proyecto, y `build-html.js`
> no tiene equivalente porque la UI se compila con esbuild, no ensamblando HTML. El
> comando equivalente pasa a ser **`npm run check`**, y lo ejecutaré tras cada cambio
> en la UI.

---

## Fuera de alcance en esta ronda

Documentado en `AUDIT.md`, para una segunda ronda con la app ya verificable:
**M8** (detener `wuauserv` antes de borrar su caché), **M9** (`sandbox: true`),
**B1** (progreso y cancelación de escaneos), **B2** (puntuación del dashboard),
**B3** (validar `senderFrame`), **B5** (versión única), **B6** (README),
**B8** (ya resuelto: hay git).

## Qué te pediré que compruebes al final

Lista concreta para tu pasada de pruebas, con lo que deberías ver:

1. Limpiar archivos con la papelera seleccionada → aparece diálogo con volumen; si
   cancelas, no se borra nada.
2. Escanear registro y limpiar → `dist/`… perdón, la carpeta de backups (botón ABRIR
   BACKUPS) contiene un `.reg` por entrada, con contenido.
3. Ejecutar el **portable** y lanzar Limpieza rápida → la app sigue funcionando; puedes
   minimizar al tray y reabrir.
4. Dashboard abierto un minuto → en el Administrador de tareas no hay más de un
   `powershell.exe` de Vokoptimizer a la vez; minimizada a la bandeja, ninguno.
5. GPU con un juego abierto → el número se mueve y **nunca pasa de 100 %**.
6. Perfil Trabajo → Equilibrado → en `powercfg /query` el plan Economizador vuelve a
   tener `PROCTHROTTLEMAX` a 100.
7. Máximo Rendimiento cinco veces → `powercfg /list` no acumula planes.
8. Reparación completa → el botón CANCELAR aborta y no queda `dism.exe` huérfano.
9. Con el equipo sin privilegios (ejecutar sin elevar) → los paneles dicen qué falló,
   no "limpio" ni "no hay elementos".
10. Intentar matar `Memory Compression` o `svchost` desde CPU/RAM → no hay botón ✕.
