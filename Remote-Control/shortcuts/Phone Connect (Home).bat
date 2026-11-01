@echo off
setlocal enabledelayedexpansion
title Phone Connect (Home) - Same Wi-Fi Connection
cd /d "%~dp0.."
echo.
echo ====================================================
echo Phone Connect - Control Antigravity From Your Phone
echo ====================================================
echo.
:: Check for .env file
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] Creating .env from template...
        copy .env.example .env >nul
    )
)
:: Check if Antigravity is running with debug port
echo [1/3] Checking Antigravity...
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:9000/json' -UseBasicParsing -TimeoutSec 2; Write-Host '[OK] Antigravity detected.' } catch { Write-Host '[WARNING] Antigravity not detected on port 9000.'; Write-Host ' Run Launch Antigravity.bat first.'; Write-Host ' Continuing anyway...' }"
echo.
:: Check Node.js
echo [2/3] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found! Install from https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js found.
echo.
:: Check dependencies
echo [3/3] Checking dependencies...
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    npm install
)
echo [OK] Ready.
echo.
echo ====================================================
echo Starting server... QR code will appear below!
echo ====================================================
echo.
chcp 65001 >nul 2>&1
set PYTHONIOENCODING=utf-8
python launcher.py --mode local
echo.
echo [INFO] Server stopped. Press any key to exit.
pause >nul
