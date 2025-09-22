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
  # Quitar cualquier parámetro que haga el proceso completamente independiente
}
$ps = Start-Process @startInfo

# Guardar PID
Set-Content -Path $pidFile -Value $ps.Id -Encoding ascii

# Esperar a que el proceso termine si se requiere (para pruebas)
# Wait-Process -Id $ps.Id

Write-Host "Bot iniciado en segundo plano. PID $($ps.Id)" -ForegroundColor Green
Write-Host "Logs: $outLog (stdout), $errLog (stderr)"

# Si se solicita, mostrar logs en vivo hasta que el usuario cierre
if ($Log) {
  Write-Host "\nMostrando logs en vivo (Ctrl+C para salir)..." -ForegroundColor Cyan
  Write-Host "[OUT] -> $outLog" -ForegroundColor DarkGray
  Write-Host "[ERR] -> $errLog" -ForegroundColor DarkGray
  try {
    $jobOut = Start-Job -ScriptBlock {
      Get-Content -Path $using:outLog -Wait -Tail 20 | ForEach-Object { "[OUT] $_" }
    }
    $jobErr = Start-Job -ScriptBlock {
      Get-Content -Path $using:errLog -Wait -Tail 20 | ForEach-Object { "[ERR] $_" }
    }
    Write-Host "(Cierra la ventana para dejar de ver logs)" -ForegroundColor DarkGray
    Wait-Job -Any $jobOut,$jobErr | Out-Null
  } catch {
    Write-Host "No se pudo hacer tail de logs: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}
