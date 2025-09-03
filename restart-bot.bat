@echo off
SETLOCAL
cd /d "%~dp0"

set ARG=
if /i "%1"=="-Log" set ARG=-Log

powershell -NoProfile -ExecutionPolicy Bypass -File ".\restart-bot.ps1" %ARG%
echo.
pause
ENDLOCAL
