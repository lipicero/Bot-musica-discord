param(
  [switch]$Log
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Verificar Node.js en PATH
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js no está instalado o no está en el PATH.' -ForegroundColor Red
  Write-Host 'Descargalo desde https://nodejs.org/ y vuelve a intentar.'
  exit 1
}

# Crear carpeta de logs y archivos de control
$logs = Join-Path $scriptDir 'logs'
if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$outLog = Join-Path $logs 'bot.out.log'
$errLog = Join-Path $logs 'bot.err.log'
$pidFile = Join-Path $scriptDir 'bot.pid'

# Evitar instancias duplicadas si ya hay un PID válido
if (Test-Path $pidFile) {
  try {
    $oldPid = [int](Get-Content $pidFile -ErrorAction Stop)
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($null -ne $proc -and $proc.ProcessName -match '^node') {
      Write-Host "Ya hay una instancia en ejecución (PID $oldPid). Usá stop-bot.bat para detenerla." -ForegroundColor Yellow
      exit 0
    } else {
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

# Iniciar node en segundo plano, ventana oculta y con redirección de logs
$startInfo = @{
  FilePath = 'node'
  ArgumentList = 'index.js'
  WorkingDirectory = $scriptDir
  WindowStyle = 'Hidden'
  RedirectStandardOutput = $outLog
  RedirectStandardError = $errLog
  PassThru = $true
}
$ps = Start-Process @startInfo

if ($null -eq $ps) {
  Write-Host 'No se pudo iniciar el proceso.' -ForegroundColor Red
  exit 1
}

# Guardar PID
Set-Content -Path $pidFile -Value $ps.Id -Encoding ascii

Write-Host "Bot iniciado en segundo plano. PID $($ps.Id)" -ForegroundColor Green
Write-Host "Logs: $outLog (stdout), $errLog (stderr)"
