$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$pidFile = Join-Path $scriptDir 'bot.pid'
if (-not (Test-Path $pidFile)) {
  Write-Host 'No hay PID registrado. ¿Está corriendo?' -ForegroundColor Yellow
  exit 0
}

try {
  $pid = [int](Get-Content $pidFile -ErrorAction Stop)
  $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
  if ($null -ne $proc) {
    Write-Host "Deteniendo PID $pid..."
    Stop-Process -Id $pid -Force
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host 'Bot detenido.' -ForegroundColor Green
} catch {
  Write-Host 'No se pudo detener. Quizás ya no existe el proceso.' -ForegroundColor Yellow
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
