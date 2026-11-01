@echo off
title Launch Antigravity
echo ===================================================
echo Launching Antigravity with Phone Connect support
echo ===================================================
echo.
start "" "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" --remote-debugging-port=9000
echo [OK] Antigravity launched. You can close this window.
timeout /t 3 /nobreak >nul
