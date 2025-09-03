$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$pidFile = Join-Path $scriptDir 'bot.pid'

function Stop-ByPid([int]$Pid) {
  try {
    $p = Get-Process -Id $Pid -ErrorAction SilentlyContinue
    if ($null -eq $p) {
      return $false
    }
    Write-Host "Deteniendo PID $Pid..."
    try {
      Stop-Process -Id $Pid -Force -ErrorAction Stop
    } catch {
      # Intento alternativo con taskkill sin propagar código de salida
      try {
        $tk = Start-Process -FilePath "taskkill" -ArgumentList "/PID $Pid /F" -NoNewWindow -Wait -PassThru -ErrorAction SilentlyContinue
        # ignorar $tk.ExitCode
      } catch {}
    }
    return $true
  } catch {
    return $false
  }
}

function Get-NodePidsForThisBot() {
  try {
    $indexPath = Join-Path $scriptDir 'index.js'
    $absEsc = [Regex]::Escape($indexPath)
    # También detectar inicio manual con ruta relativa: "node index.js"
    $relPattern = '(?i)(^|[ \t' + '"' + "'" + '])index\.js([ \t' + '"' + "'" + ']|$)'
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -match '(?i)^node(\.exe)?$' -and (
          ($_.CommandLine -match $absEsc) -or ($_.CommandLine -match $relPattern)
        )
      }
    return @($procs | ForEach-Object { [int]$_.ProcessId })
  } catch { @() }
}

if (-not (Test-Path $pidFile)) {
  # No hay PID; intentar encontrar procesos node index.js de este proyecto
  $pids = Get-NodePidsForThisBot
  if ($pids.Count -gt 0) {
    Write-Host "No hay PID registrado, pero se encontraron $($pids.Count) proceso(s) del bot. Intentando detener..." -ForegroundColor Yellow
    try { foreach ($pid in $pids) { Stop-ByPid $pid | Out-Null } } catch {}
    Write-Host 'Detenido(s). (limpieza de PID no requerida)' -ForegroundColor Green
  } else {
    Write-Host 'No hay PID registrado. No parece estar corriendo.' -ForegroundColor Yellow
  }
  $global:LASTEXITCODE = 0
  exit 0
}

try {
  $pid = [int](Get-Content $pidFile -ErrorAction Stop)
} catch {
  Write-Host 'PID inválido en bot.pid. Limpiando archivo.' -ForegroundColor Yellow
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

$stopped = Stop-ByPid $pid
if (-not $stopped) {
  # Fallback: buscar por command line index.js en este proyecto
  $pids = (Get-NodePidsForThisBot | Where-Object { $_ -ne $pid })
  if ($pids.Count -gt 0) {
    Write-Host "El PID $pid no estaba activo. Deteniendo $($pids.Count) proceso(s) coincidentes..." -ForegroundColor Yellow
    foreach ($p in $pids) { Stop-ByPid $p | Out-Null }
  } else {
    Write-Host 'El proceso ya no existe.' -ForegroundColor Yellow
  }
}

# Limpiar PID file siempre
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host 'Bot detenido.' -ForegroundColor Green
 $global:LASTEXITCODE = 0
 exit 0
