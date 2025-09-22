@echo off
SETLOCAL
cd /d "%~dp0"

REM Check the bot's status
powershell -NoProfile -ExecutionPolicy Bypass -File ".\status-bot.ps1"
pause

ENDLOCAL
