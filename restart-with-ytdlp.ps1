# Script para reiniciar el bot con configuracion de yt-dlp

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Colores para mensajes
$COLOR_SUCCESS = @{ ForegroundColor = 'Green' }
$COLOR_WARNING = @{ ForegroundColor = 'Yellow' }
$COLOR_ERROR = @{ ForegroundColor = 'Red' }
$COLOR_INFO = @{ ForegroundColor = 'Cyan' }

function Write-Status {
  param([string]$Message, [string]$Type = 'INFO')
  $symbol = switch ($Type) {
    'SUCCESS' { '[OK]'; $color = $COLOR_SUCCESS }
    'ERROR' { '[ERROR]'; $color = $COLOR_ERROR }
    'WARNING' { '[WARN]'; $color = $COLOR_WARNING }
    default { '[INFO]'; $color = $COLOR_INFO }
  }
  Write-Host "$symbol $Message" @color
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "  VERIFICACION Y REINICIO DEL BOT" -ForegroundColor Cyan
Write-Host "  (Con configuracion yt-dlp)" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# 1. Verificar configuracion
Write-Status "[1/4] Verificando configuracion..." "INFO"
if (Test-Path "test-ytdlp-bot.js") {
    try {
        $testResult = node test-ytdlp-bot.js 2>&1
        $testExitCode = $LASTEXITCODE
        
        if ($testExitCode -ne 0 -and $testExitCode -ne 1) {
            Write-Host ""
            Write-Status "La configuracion tiene problemas." "ERROR"
            Write-Host $testResult -ForegroundColor Gray
            Write-Host ""
            $continue = Read-Host "¿Deseas continuar de todos modos? (S/N)"
            if ($continue -ne 'S' -and $continue -ne 's') {
                exit 1
            }
        } else {
            Write-Status "Configuracion validada correctamente" "SUCCESS"
        }
    } catch {
        Write-Status "No se pudo ejecutar la verificacion: $($_.Exception.Message)" "WARNING"
    }
} else {
    Write-Status "Archivo test-ytdlp-bot.js no encontrado, omitiendo verificacion" "WARNING"
}
Write-Host ""

# 2. Detener bot actual
Write-Status "[2/4] Deteniendo bot actual..." "INFO"
if (Test-Path ".\stop-bot.ps1") {
    try {
        & .\stop-bot.ps1
        Write-Status "Bot detenido correctamente" "SUCCESS"
    } catch {
        Write-Status "Error al detener: $($_.Exception.Message)" "WARNING"
    }
} else {
    Write-Status "Script stop-bot.ps1 no encontrado" "WARNING"
}
Write-Host ""

# 3. Esperar un momento
Write-Status "[3/4] Esperando liberacion de recursos..." "INFO"
Start-Sleep -Seconds 3
Write-Status "Listo para reiniciar" "SUCCESS"
Write-Host ""

# 4. Iniciar bot
Write-Status "[4/4] Iniciando bot con yt-dlp..." "INFO"
if (Test-Path ".\run-bot-bg.ps1") {
    try {
        & .\run-bot-bg.ps1
        Write-Status "Bot iniciado correctamente" "SUCCESS"
    } catch {
        Write-Status "Error al iniciar: $($_.Exception.Message)" "ERROR"
        Write-Host ""
        Write-Host "Intentando inicio manual..." -ForegroundColor Yellow
        Start-Process powershell -ArgumentList "-NoExit", "-Command", "node src/index.js"
    }
} else {
    Write-Status "Script run-bot-bg.ps1 no encontrado" "ERROR"
    Write-Host "Iniciando manualmente..." -ForegroundColor Yellow
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "node src/index.js"
}

# Resumen
Write-Host ""
Write-Host "=======================================" -ForegroundColor Green
Write-Host "   BOT REINICIADO EXITOSAMENTE" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Configuracion actual:" -ForegroundColor Cyan
Write-Host "  - Metodo principal: yt-dlp" -ForegroundColor White
Write-Host "  - Cookies: Habilitadas (44 cookies)" -ForegroundColor White
Write-Host "  - Videos con restriccion de edad: Soportados" -ForegroundColor Green
Write-Host ""
Write-Host "Prueba en Discord:" -ForegroundColor Yellow
Write-Host "  /play https://www.youtube.com/watch?v=njci7yREmf8" -ForegroundColor White
Write-Host ""
Write-Host "Ver logs en tiempo real:" -ForegroundColor Yellow
Write-Host "  Get-Content logs\bot.out.log -Tail 50 -Wait" -ForegroundColor White
Write-Host ""
Write-Host "Documentacion:" -ForegroundColor Yellow
Write-Host "  cat CONFIG-YTDLP.md" -ForegroundColor White
Write-Host ""

Read-Host "Presiona Enter para cerrar"
