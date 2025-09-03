param(
  [switch]$Log
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host 'Reiniciando bot...' -ForegroundColor Cyan

# Detener si está corriendo (ignorar errores si no lo está)
try {
  & "$scriptDir\stop-bot.ps1"
} catch {
  Write-Host "Aviso: no se pudo detener (quizás no estaba corriendo)." -ForegroundColor Yellow
}

Start-Sleep -Milliseconds 500

# Iniciar nuevamente (con o sin tail de logs)
try {
  if ($Log) {
    & "$scriptDir\run-bot-bg.ps1" -Log
  } else {
    & "$scriptDir\run-bot-bg.ps1"
  }
} catch {
  Write-Host "Error al iniciar: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

if (-not $Log) {
  Write-Host "Hecho. Usá 'status-bot.bat' para ver el estado o 'start-bot-bg.bat' para iniciar con logs." -ForegroundColor Green
}
