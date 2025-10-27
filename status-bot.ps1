# Script para verificar el estado del bot de Discord
$ErrorActionPreference = 'SilentlyContinue'
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

function Get-BotProcesses {
  $indexPath = Join-Path $scriptDir 'src\index.js'
  $absEsc = [Regex]::Escape($indexPath)
  
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match '(?i)^node(\.exe)?$' -and (
        ($_.CommandLine -match $absEsc) -or
        ($_.CommandLine -match 'src\\index\.js') -or
        ($_.CommandLine -match 'src/index\.js')
      )
    }
  
  return $procs
}

function Format-Uptime {
  param([TimeSpan]$Uptime)
  if ($Uptime.Days -gt 0) {
    return "{0}d {1}h {2}m" -f $Uptime.Days, $Uptime.Hours, $Uptime.Minutes
  } elseif ($Uptime.Hours -gt 0) {
    return "{0}h {1}m {2}s" -f $Uptime.Hours, $Uptime.Minutes, $Uptime.Seconds
  } elseif ($Uptime.Minutes -gt 0) {
    return "{0}m {1}s" -f $Uptime.Minutes, $Uptime.Seconds
  } else {
    return "{0}s" -f $Uptime.Seconds
  }
}

function Get-LogFileInfo {
  param([string]$Path)
  if (Test-Path $Path) {
    $file = Get-Item $Path
    $sizeKB = [math]::Round($file.Length / 1KB, 2)
    $lines = (Get-Content $Path -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
    return @{
      Exists = $true
      Size = "$sizeKB KB"
      Lines = $lines
      LastModified = $file.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
    }
  } else {
    return @{ Exists = $false }
  }
}

# Header
Clear-Host
Write-Host ""
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host "              ESTADO DEL BOT DE DISCORD" -ForegroundColor Cyan
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host ""

# Verificar archivo PID
$pidFile = Join-Path $scriptDir 'bot.pid'
$hasPidFile = Test-Path $pidFile
$registeredPid = $null

if ($hasPidFile) {
  try {
    $registeredPid = [int](Get-Content $pidFile -ErrorAction Stop)
    Write-Host "PID Registrado:  " -NoNewline -ForegroundColor White
    Write-Host $registeredPid -ForegroundColor Yellow
  } catch {
    Write-Status "Archivo PID corrupto" "WARNING"
    $hasPidFile = $false
  }
} else {
  Write-Host "PID Registrado:  " -NoNewline -ForegroundColor White
  Write-Host "No hay archivo PID" -ForegroundColor Gray
}

# Buscar procesos del bot
$processes = Get-BotProcesses
$processCount = ($processes | Measure-Object).Count

Write-Host "Procesos Activos:" -NoNewline -ForegroundColor White
if ($processCount -eq 0) {
  Write-Host " Ninguno" -ForegroundColor Red
} elseif ($processCount -eq 1) {
  Write-Host " 1 proceso" -ForegroundColor Green
} else {
  Write-Host " $processCount procesos" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "-----------------------------------------------------------" -ForegroundColor Gray
Write-Host ""

# Estado general
if ($processCount -eq 0) {
  Write-Host "Estado: " -NoNewline -ForegroundColor White
  Write-Host "DETENIDO" -ForegroundColor Red
  Write-Host ""
  Write-Host "El bot no esta ejecutandose." -ForegroundColor Gray
  Write-Host ""
  Write-Host "Para iniciar el bot, ejecuta:" -ForegroundColor Cyan
  Write-Host "  .\run-bot-bg.ps1" -ForegroundColor White
  Write-Host ""
} else {
  Write-Host "Estado: " -NoNewline -ForegroundColor White
  Write-Host "ACTIVO" -ForegroundColor Green
  Write-Host ""
  
  # Mostrar informacion de cada proceso
  foreach ($proc in $processes) {
    $pid = $proc.ProcessId
    $process = Get-Process -Id $pid -ErrorAction SilentlyContinue
    
    if ($null -ne $process) {
      $memoryMB = [math]::Round($process.WorkingSet / 1MB, 2)
      $cpuSeconds = [math]::Round($process.CPU, 2)
      $uptime = (Get-Date) - $process.StartTime
      $uptimeStr = Format-Uptime $uptime
      
      $isRegistered = ($pid -eq $registeredPid)
      $pidLabel = if ($isRegistered) { "$pid (registrado)" } else { "$pid" }
      
      Write-Host "  Proceso:     " -NoNewline -ForegroundColor White
      Write-Host $pidLabel -ForegroundColor $(if ($isRegistered) { 'Green' } else { 'Yellow' })
      Write-Host "  Memoria:     " -NoNewline -ForegroundColor White
      Write-Host "$memoryMB MB" -ForegroundColor White
      Write-Host "  CPU (total): " -NoNewline -ForegroundColor White
      Write-Host "$cpuSeconds s" -ForegroundColor White
      Write-Host "  Uptime:      " -NoNewline -ForegroundColor White
      Write-Host $uptimeStr -ForegroundColor White
      Write-Host "  Inicio:      " -NoNewline -ForegroundColor White
      Write-Host $process.StartTime.ToString("yyyy-MM-dd HH:mm:ss") -ForegroundColor Gray
      
      if ($processCount -gt 1 -and $proc -ne $processes[-1]) {
        Write-Host ""
      }
    }
  }
  
  # Advertencia si hay multiples procesos
  if ($processCount -gt 1) {
    Write-Host ""
    Write-Status "Hay multiples instancias del bot ejecutandose" "WARNING"
    Write-Host "  Considera detener todas con .\stop-bot.ps1 y reiniciar" -ForegroundColor Gray
  }
}

# Informacion de logs
Write-Host ""
Write-Host "-----------------------------------------------------------" -ForegroundColor Gray
Write-Host ""
Write-Host "Informacion de Logs:" -ForegroundColor Cyan
Write-Host ""

$outLog = Join-Path $scriptDir 'logs\bot.out.log'
$errLog = Join-Path $scriptDir 'logs\bot.err.log'

$outInfo = Get-LogFileInfo $outLog
$errInfo = Get-LogFileInfo $errLog

# Log de salida estandar
Write-Host "  Salida (stdout):" -ForegroundColor White
if ($outInfo.Exists) {
  Write-Host "    Archivo:         bot.out.log" -ForegroundColor Gray
  Write-Host "    Tamano:          $($outInfo.Size)" -ForegroundColor Gray
  Write-Host "    Lineas:          $($outInfo.Lines)" -ForegroundColor Gray
  Write-Host "    ultima modif.:   $($outInfo.LastModified)" -ForegroundColor Gray
} else {
  Write-Host "    No existe" -ForegroundColor Yellow
}

Write-Host ""

# Log de errores
Write-Host "  Errores (stderr):" -ForegroundColor White
if ($errInfo.Exists) {
  Write-Host "    Archivo:         bot.err.log" -ForegroundColor Gray
  Write-Host "    Tamano:          $($errInfo.Size)" -ForegroundColor Gray
  Write-Host "    Lineas:          $($errInfo.Lines)" -ForegroundColor Gray
  Write-Host "    ultima modif.:   $($errInfo.LastModified)" -ForegroundColor Gray
  
  # Verificar si hay errores recientes
  if ($errInfo.Lines -gt 0) {
    $recentErrors = Get-Content $errLog -Tail 5 -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne "" }
    if ($recentErrors) {
      Write-Host ""
      Write-Status "Hay errores en el log" "WARNING"
    }
  }
} else {
  Write-Host "    No existe" -ForegroundColor Yellow
}

# Comandos utiles
Write-Host ""
Write-Host "---------------------------------------------------------------" -ForegroundColor Gray
Write-Host ""
Write-Host "Comandos disponibles:" -ForegroundColor Cyan
Write-Host "  .\run-bot-bg.ps1      - Iniciar el bot en segundo plano" -ForegroundColor Gray
Write-Host "  .\stop-bot.ps1        - Detener el bot" -ForegroundColor Gray
Write-Host "  .\restart-bot.ps1     - Reiniciar el bot" -ForegroundColor Gray
Write-Host "  .\monitor-bot.ps1     - Monitor interactivo con logs en vivo" -ForegroundColor Gray
Write-Host ""
Write-Host "===============================================================" -ForegroundColor Cyan
Write-Host ""
