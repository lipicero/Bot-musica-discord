$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$pidFile = Join-Path $scriptDir 'bot.pid'
if (-not (Test-Path $pidFile)) {
  # Buscar procesos node que apunten a este index.js (iniciado manualmente)
  try {
    $indexPath = Join-Path $scriptDir 'index.js'
    $absEsc = [Regex]::Escape($indexPath)
    $relPattern = '(?i)(^|[ \t' + '"' + "'" + '])index\.js([ \t' + '"' + "'" + ']|$)'
    $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -match '(?i)^node(\.exe)?$' -and (
          ($_.CommandLine -match $absEsc) -or ($_.CommandLine -match $relPattern)
        )
      }
    $pids = @($procs | ForEach-Object { [int]$_.ProcessId })
    if ($pids.Count -gt 0) {
      Write-Host "Estado: en ejecución sin PID (iniciado manualmente). PID(s): $($pids -join ', ')" -ForegroundColor Yellow
      exit 0
    }
  } catch {}
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
