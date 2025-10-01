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

# Iniciar node en segundo plano como proceso independiente
# Usar cmd.exe para crear un proceso completamente desacoplado
$nodeCmd = "node"
$nodeArgs = "src\index.js"
$logRedirect = ">> `"$outLog`" 2>> `"$errLog`""

# Crear un script temporal para ejecutar node de forma independiente
$tempScript = Join-Path $env:TEMP "start-discord-bot-$([guid]::NewGuid().ToString('N').Substring(0,8)).cmd"
@"
@echo off
cd /d "$scriptDir"
start /b "" "$nodeCmd" $nodeArgs >> "$outLog" 2>> "$errLog"
"@ | Out-File -FilePath $tempScript -Encoding ascii

# Ejecutar el script temporal y obtener el PID del proceso node
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = "cmd.exe"
$startInfo.Arguments = "/c `"$tempScript`""
$startInfo.WorkingDirectory = $scriptDir
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.CreateNoWindow = $true
$startInfo.UseShellExecute = $false

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $startInfo
$process.Start() | Out-Null
$process.WaitForExit()

# Esperar a que node.exe inicie y obtener su PID
Start-Sleep -Milliseconds 1500

# Buscar el proceso node más reciente para este bot
$indexPath = Join-Path $scriptDir 'src\index.js'
$absEsc = [Regex]::Escape($indexPath)
$nodeProc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '(?i)^node(\.exe)?$' -and $_.CommandLine -match $absEsc } |
  Sort-Object CreationDate -Descending |
  Select-Object -First 1

if ($null -eq $nodeProc) {
  Write-Host "Advertencia: No se pudo obtener el PID del proceso. El bot puede estar iniciando..." -ForegroundColor Yellow
  Write-Host "Espera unos segundos y usa status-bot.ps1 para verificar." -ForegroundColor Yellow
  # Limpiar script temporal
  Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
  exit 0
}

$pid = [int]$nodeProc.ProcessId

# Guardar PID
Set-Content -Path $pidFile -Value $pid -Encoding ascii

# Limpiar script temporal
Remove-Item $tempScript -Force -ErrorAction SilentlyContinue

Write-Host "Bot iniciado en segundo plano. PID $pid" -ForegroundColor Green
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
