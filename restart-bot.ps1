param(
  [switch]$Log,
  [switch]$Fast
)

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
Write-Host "    REINICIANDO BOT DE DISCORD" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Paso 1: Detener el bot actual
Write-Status "Deteniendo bot actual..." "INFO"
try {
  & "$scriptDir\stop-bot.ps1"
  Write-Status "Bot detenido correctamente" "SUCCESS"
} catch {
  Write-Status "Advertencia al detener: $($_.Exception.Message)" "WARNING"
}

# Paso 2: Esperar un momento para asegurar liberacion de recursos
if (-not $Fast) {
  Write-Status "Esperando liberacion de recursos (2 segundos)..." "INFO"
  Start-Sleep -Seconds 2
} else {
  Start-Sleep -Milliseconds 500
}

# Paso 3: Iniciar nuevamente
Write-Host ""
Write-Status "Iniciando bot..." "INFO"
try {
  if ($Log) {
    & "$scriptDir\run-bot-bg.ps1" -Log
  } else {
    & "$scriptDir\run-bot-bg.ps1"
  }
} catch {
  Write-Status "Error al iniciar: $($_.Exception.Message)" "ERROR"
  Write-Host ""
  exit 1
}

if (-not $Log) {
  Write-Host ""
  Write-Host "=======================================" -ForegroundColor Green
  Write-Host "    BOT REINICIADO EXITOSAMENTE" -ForegroundColor Green
  Write-Host "=======================================" -ForegroundColor Green
  Write-Host ""
  Write-Host "Comandos utiles:" -ForegroundColor Cyan
  Write-Host "  .\monitor-bot.ps1  - Ver estado y logs en tiempo real" -ForegroundColor Gray
  Write-Host "  .\stop-bot.ps1     - Detener el bot" -ForegroundColor Gray
  Write-Host ""
}

