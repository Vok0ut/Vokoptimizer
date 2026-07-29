@echo off
chcp 65001 >nul 2>&1
title Vokoptimizer - Build System
color 0A

echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║           VOKOPTIMIZER BUILD SYSTEM              ║
echo  ║              v4.2.0 · Windows                    ║
echo  ╚══════════════════════════════════════════════════╝
echo.

:: ─── CHECK NODE.JS ───────────────────────────────────
echo [1/5] Verificando Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [ERROR] Node.js no esta instalado.
    echo  Descargalo en: https://nodejs.org/
    echo  Instala la version LTS y vuelve a ejecutar este script.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo   √ Node.js %NODE_VER% detectado

:: ─── CHECK NPM ───────────────────────────────────────
echo.
echo [2/5] Verificando npm...
where npm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] npm no encontrado. Reinstala Node.js.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('npm -v') do set NPM_VER=%%i
echo   √ npm v%NPM_VER% detectado

:: ─── INSTALL DEPENDENCIES ────────────────────────────
echo.
echo [3/5] Instalando dependencias...
echo   Esto puede tardar unos minutos la primera vez...
echo.
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [ERROR] Fallo la instalacion de dependencias.
    echo  Intenta borrar node_modules y ejecutar de nuevo.
    pause
    exit /b 1
)
echo.
echo   √ Dependencias instaladas correctamente

:: ─── TEST RUN (optional) ─────────────────────────────
echo.
echo [4/5] Verificando que la app arranca...
echo   (Puedes cerrar la ventana de prueba)
echo.
set /p TEST_RUN="  Quieres probar la app antes de compilar? (S/N): "
if /i "%TEST_RUN%"=="S" (
    echo   Abriendo Vokoptimizer...
    call npx electron . 
    echo   √ Test completado
)

:: ─── BUILD EXE ───────────────────────────────────────
echo.
echo [5/5] Compilando instalador y portable...
echo   Generando ejecutables en dist\...
echo.
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [ERROR] Fallo la compilacion.
    echo  Revisa los errores arriba.
    pause
    exit /b 1
)

echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║          BUILD COMPLETADO CON EXITO!             ║
echo  ╠══════════════════════════════════════════════════╣
echo  ║                                                  ║
echo  ║  Ejecutables generados en .\dist\ :              ║
echo  ║    Vokoptimizer-4.2.0-Setup.exe    (instalador)  ║
echo  ║    Vokoptimizer-4.2.0-Portable.exe (portable)    ║
echo  ║                                                  ║
echo  ║  El instalador crea accesos directos en el       ║
echo  ║  escritorio y el menu inicio.                    ║
echo  ║                                                  ║
echo  ╚══════════════════════════════════════════════════╝
echo.

:: Open dist folder
explorer dist

pause
