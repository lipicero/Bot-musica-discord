$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$pidFile = Join-Path $scriptDir 'bot.pid'

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

function Stop-ByPid([int]$ProcessId) {
  try {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $p) {
      return $false
    }
    Write-Status "Deteniendo proceso PID $ProcessId..." "INFO"
    try {
      Stop-Process -Id $ProcessId -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 300
      # Verificar que realmente se detuvo
      $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
      if ($null -eq $p) {
        Write-Status "Proceso $ProcessId detenido correctamente" "SUCCESS"
        return $true
      }
    } catch {
      # Intento alternativo con taskkill
      Write-Status "Usando taskkill como alternativa..." "WARNING"
      try {
        $result = Start-Process -FilePath "taskkill" -ArgumentList "/PID $ProcessId /F /T" -NoNewWindow -Wait -PassThru -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
        $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $p) {
          Write-Status "Proceso $ProcessId detenido con taskkill" "SUCCESS"
          return $true
        }
      } catch {}
    }
    return $false
  } catch {
    return $false
  }
}

function Get-NodePidsForThisBot() {
  try {
    $indexPath = Join-Path $scriptDir 'src\index.js'
    $absEsc = [Regex]::Escape($indexPath)
    # Detectar inicio con ruta absoluta, relativa con src\, o solo index.js
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -match '(?i)^node(\.exe)?$' -and (
          ($_.CommandLine -match $absEsc) -or
          ($_.CommandLine -match 'src\\index\.js') -or
          ($_.CommandLine -match 'src/index\.js')
        )
      }
    return @($procs | ForEach-Object { [int]$_.ProcessId })
  } catch { 
    return @() 
  }
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "    DETENIENDO BOT DE DISCORD" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path $pidFile)) {
  Write-Status "No hay archivo PID registrado" "WARNING"
  $pids = Get-NodePidsForThisBot
  if ($pids.Count -gt 0) {
    Write-Status "Se encontraron $($pids.Count) proceso(s) del bot ejecutandose" "INFO"
    $stopped = 0
    foreach ($botPid in $pids) {
      if (Stop-ByPid $botPid) {
        $stopped++
      }
    }
    Write-Host ""
    if ($stopped -gt 0) {
      Write-Status "Se detuvieron $stopped proceso(s)" "SUCCESS"
    } else {
      Write-Status "No se pudo detener ningun proceso" "ERROR"
    }
  } else {
    Write-Status "El bot no parece estar ejecutandose" "INFO"
  }
  $global:LASTEXITCODE = 0
  Write-Host ""
  exit 0
}

try {
  $pid = [int](Get-Content $pidFile -ErrorAction Stop)
  Write-Status "PID registrado: $pid" "INFO"
} catch {
  Write-Status "PID invalido en bot.pid. Limpiando archivo." "WARNING"
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host ""
  exit 0
}

$stopped = Stop-ByPid $pid

if (-not $stopped) {
  Write-Status "El proceso registrado (PID $pid) no esta activo" "WARNING"
  # Fallback: buscar por command line index.js en este proyecto
  $pids = (Get-NodePidsForThisBot | Where-Object { $_ -ne $pid })
  if ($pids.Count -gt 0) {
    Write-Status "Buscando otros procesos del bot..." "INFO"
    $altStopped = 0
    foreach ($botPid in $pids) { 
      if (Stop-ByPid $botPid) {
        $altStopped++
      }
    }
    if ($altStopped -gt 0) {
      Write-Status "Se detuvieron $altStopped proceso(s) adicionales" "SUCCESS"
    }
  } else {
    Write-Status "No se encontraron otros procesos del bot" "INFO"
  }
}

# Limpiar PID file siempre
if (Test-Path $pidFile) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Write-Status "Archivo PID limpiado" "SUCCESS"
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Green
Write-Host "    BOT DETENIDO" -ForegroundColor Green
Write-Host "=======================================" -ForegroundColor Green
Write-Host ""

$global:LASTEXITCODE = 0
exit 0

