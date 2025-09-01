@echo off
REM Arranca el bot en segundo plano con logs usando PowerShell
SETLOCAL
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\run-bot-bg.ps1" -Log
echo.
pause
ENDLOCAL
