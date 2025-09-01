$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$pidFile = Join-Path $scriptDir 'bot.pid'
if (-not (Test-Path $pidFile)) {
  Write-Host 'Estado: no hay PID. No parece estar corriendo.'
  exit 0
}

try {
  $pid = [int](Get-Content $pidFile -ErrorAction Stop)
  $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
  if ($null -ne $proc) {
    Write-Host "Estado: en ejecución. PID $pid (Proceso: $($proc.ProcessName))" -ForegroundColor Green
  } else {
    Write-Host 'Estado: PID encontrado pero el proceso no está activo.' -ForegroundColor Yellow
  }
} catch {
  Write-Host 'Estado: error leyendo PID.' -ForegroundColor Yellow
}
