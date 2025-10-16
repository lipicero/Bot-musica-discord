@echo off
echo ========================================
echo   VERIFICACION Y REINICIO DEL BOT
echo ========================================
echo.

echo [1/4] Verificando configuracion...
node test-ytdlp-bot.js
if errorlevel 1 (
    echo.
    echo ERROR: La configuracion tiene problemas.
    echo Revisa el output anterior.
    pause
    exit /b 1
)

echo.
echo [2/4] Deteniendo bot actual...
call stop-bot.ps1

echo.
echo [3/4] Esperando 3 segundos...
timeout /t 3 /nobreak > nul

echo.
echo [4/4] Iniciando bot con yt-dlp...
call run-bot-bg.ps1

echo.
echo ========================================
echo   BOT REINICIADO EXITOSAMENTE
echo ========================================
echo.
echo El bot ahora usa yt-dlp como metodo principal.
echo.
echo Prueba en Discord:
echo   /play https://www.youtube.com/watch?v=njci7yREmf8
echo.
echo Ver logs:
echo   Get-Content logs\bot.out.log -Tail 50 -Wait
echo.
pause
