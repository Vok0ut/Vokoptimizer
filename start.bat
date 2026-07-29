@echo off
chcp 65001 >nul 2>&1
title Vokoptimizer - Dev Mode
echo.
echo  VOKOPTIMIZER · Dev Mode
echo  ─────────────────────────
echo.

if not exist node_modules (
    echo  Instalando dependencias...
    call npm install
)

echo  Iniciando app...
call npx electron .
