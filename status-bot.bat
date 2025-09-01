@echo off
SETLOCAL
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\status-bot.ps1"
echo.
pause
ENDLOCAL
