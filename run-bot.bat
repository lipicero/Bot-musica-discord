@echo off
REM Script para iniciar el bot de Discord en segundo plano y mostrar feedback
powershell -ExecutionPolicy Bypass -File "run-bot-bg.ps1"
pause
exit /b