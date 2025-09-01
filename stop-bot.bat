@echo off
SETLOCAL
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\stop-bot.ps1"
echo.
pause
ENDLOCAL
