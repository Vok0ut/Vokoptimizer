# ☠ Vokoptimizer v4.0.0

**Optimizador real de sistema para Windows 10/11.** Aplicación de escritorio (Electron) que ejecuta operaciones reales sobre el sistema: mide y limpia archivos basura, gestiona servicios y programas de arranque, libera memoria, repara el sistema y monitoriza recursos en tiempo real.

> **Todos los datos y acciones son reales** (no hay valores simulados). Las métricas provienen de `systeminformation`; las operaciones se ejecutan vía PowerShell/`powercfg`/`sc`/`reg`.

## Características

| Módulo | Qué hace de verdad |
|---|---|
| **Dashboard** | Métricas en vivo (CPU, RAM, GPU, disco, temperatura, red, procesos, uptime), info del equipo real, perfiles de energía (Gaming/Trabajo/Equilibrado/Ultimate) y acciones rápidas. |
| **Limpiar archivos** | Escanea y **mide el tamaño real** de temporales, cachés de navegador, papelera, miniaturas, volcados, WER, Windows Update, Prefetch… y los elimina. |
| **Servicios** | Lista servicios reales con su estado, permite iniciar/detener y cambiar el tipo de inicio (Auto/Manual/Desactivado). |
| **Arranque** | Lista los programas de inicio reales (registro + carpetas) y los activa/desactiva de forma reversible (mismo mecanismo que el Administrador de tareas). |
| **CPU / RAM** | Libera memoria de verdad vaciando el *working set* de los procesos (`EmptyWorkingSet`) y permite finalizar procesos. |
| **Mantenimiento** | Escaneo **real y conservador** del registro (entradas huérfanas) con **copia de seguridad `.reg` automática** antes de borrar, punto de restauración y reparación `SFC` / `DISM` con log en vivo. |
| **Monitoreo** | Gráficas en tiempo real de CPU/RAM/GPU/red y procesos activos. |
| **Historial** | Registro persistente de cada operación y espacio liberado. |

## Aplicación de escritorio nativa

- **Arranque instantáneo**: la interfaz se **precompila con esbuild** a un único `app.bundle.js` (~190 KB). Sin transpilación en tiempo de ejecución ni dependencias de CDN — funciona sin conexión.
- **Controles de ventana nativos de Windows** (minimizar / maximizar / cerrar) con estados de *hover*, barra de título arrastrable y restauración del tamaño/posición de la ventana entre sesiones.
- **Icono en la bandeja del sistema** (abrir / salir).
- **Auto-elevación UAC**: al abrir solicita permisos de administrador automáticamente para que todas las optimizaciones funcionen. Si se cancela, sigue abriendo con un aviso y un botón **«Elevar permisos»**.

## Requisitos

- **Node.js** v18+ → [Descargar](https://nodejs.org/) *(solo para compilar)*
- **Windows** 10/11 (x64)

## Desarrollo

```bash
npm install      # dependencias
npm start        # compila el renderer y arranca la app
```

> `npm run dev:renderer` deja esbuild en modo *watch* mientras desarrollas la UI.

## Compilar el ejecutable

```bash
npm run build            # instalador NSIS + portable  (recomendado)
npm run build-installer  # solo instalador  → dist/Vokoptimizer-4.0.0-Setup.exe
npm run build-portable   # solo portable    → dist/Vokoptimizer-4.0.0-Portable.exe
```

O haz doble clic en `build.bat`. Los `.exe` se generan en `dist/`. El instalador crea accesos directos en el escritorio y el menú inicio.

## Estructura

```
vokoptimizer/
├── main.js            # Proceso principal: IPC + operaciones reales del sistema, tray, ventana
├── preload.js         # Puente seguro (contextBridge)
├── esbuild.config.js  # Compilación del renderer
├── package.json
├── icon.ico / icon.png
└── src/
    ├── renderer.jsx   # Interfaz (React, fuente)
    ├── app.bundle.js  # Bundle compilado (generado)
    └── index.html     # Carga el bundle
```

## Seguridad y reversibilidad

- La limpieza solo toca rutas de caché/temporales conocidas.
- Desactivar servicios o programas de arranque es **reversible** desde la propia app.
- Antes de eliminar entradas del registro se exporta un **backup `.reg`** (botón «Abrir backups»).
- Se puede crear un **punto de restauración** del sistema antes de operar.
