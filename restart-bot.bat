@echo off
SETLOCAL
cd /d "%~dp0"

REM Ensure the bot is restarted correctly
powershell -NoProfile -ExecutionPolicy Bypass -File ".\restart-bot.ps1" %*

ENDLOCAL
