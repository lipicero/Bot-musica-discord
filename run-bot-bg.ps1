param(
  [switch]$Log,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Colores y simbolos para mejor visualizacion
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

# Verificar Node.js en PATH
Write-Status "Verificando dependencias..." "INFO"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Status 'Node.js no esta instalado o no esta en el PATH.' "ERROR"
  Write-Host 'Descargalo desde https://nodejs.org/ y vuelve a intentar.' -ForegroundColor Gray
  exit 1
}

$nodeVersion = node --version
Write-Status "Node.js $nodeVersion detectado" "SUCCESS"

# Verificar que exista el archivo principal
$mainScript = Join-Path $scriptDir 'src\index.js'
if (-not (Test-Path $mainScript)) {
  Write-Status "No se encuentra el archivo principal: src\index.js" "ERROR"
  exit 1
}

# Verificar node_modules
if (-not (Test-Path (Join-Path $scriptDir 'node_modules'))) {
  Write-Status "No se encuentra node_modules. Ejecuta 'npm install' primero." "WARNING"
  $install = Read-Host "¿Deseas instalar las dependencias ahora? (S/N)"
  if ($install -eq 'S' -or $install -eq 's') {
    Write-Status "Instalando dependencias..." "INFO"
    npm install
    if ($LASTEXITCODE -ne 0) {
      Write-Status "Error al instalar dependencias" "ERROR"
      exit 1
    }
    Write-Status "Dependencias instaladas correctamente" "SUCCESS"
  } else {
    exit 1
  }
}

# Crear carpeta de logs y archivos de control
$logs = Join-Path $scriptDir 'logs'
if (-not (Test-Path $logs)) { 
  New-Item -ItemType Directory -Path $logs | Out-Null 
  Write-Status "Carpeta de logs creada" "SUCCESS"
}
$outLog = Join-Path $logs 'bot.out.log'
$errLog = Join-Path $logs 'bot.err.log'
$pidFile = Join-Path $scriptDir 'bot.pid'

# Evitar instancias duplicadas si ya hay un PID valido
if (Test-Path $pidFile) {
  try {
    $oldPid = [int](Get-Content $pidFile -ErrorAction Stop)
    $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($null -ne $proc -and $proc.ProcessName -match '^node') {
      if ($Force) {
        Write-Status "Deteniendo instancia existente (PID $oldPid)..." "WARNING"
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
      } else {
        Write-Status "Ya hay una instancia en ejecucion (PID $oldPid)." "WARNING"
        Write-Host "Usa 'stop-bot.ps1' para detenerla o agrega -Force para forzar el reinicio." -ForegroundColor Gray
        exit 0
      }
    } else {
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

# Iniciar node en segundo plano como proceso independiente
Write-Status "Iniciando bot en segundo plano..." "INFO"

# Usar cmd.exe para crear un proceso completamente desacoplado
$nodeCmd = "node"
$nodeArgs = "src\index.js"

# Crear un script temporal para ejecutar node de forma independiente
$tempScript = Join-Path $env:TEMP "start-discord-bot-$([guid]::NewGuid().ToString('N').Substring(0,8)).cmd"
@"
@echo off
cd /d "$scriptDir"
start /b "" "$nodeCmd" $nodeArgs >> "$outLog" 2>> "$errLog"
"@ | Out-File -FilePath $tempScript -Encoding ascii

# Ejecutar el script temporal
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

# Esperar a que node.exe inicie
Write-Status "Esperando inicializacion del proceso..." "INFO"

# Buscar el proceso node mas reciente para este bot con reintentos
$indexPath = Join-Path $scriptDir 'src\index.js'
$absEsc = [Regex]::Escape($indexPath)
$nodeProc = $null
$maxAttempts = 10
$attempt = 0

while ($attempt -lt $maxAttempts -and $null -eq $nodeProc) {
  Start-Sleep -Milliseconds 500
  $attempt++
  
  # Buscar por ruta absoluta o relativa src\index.js
  $nodeProc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { 
      $_.Name -match '(?i)^node(\.exe)?$' -and (
        ($_.CommandLine -match $absEsc) -or 
        ($_.CommandLine -match 'src\\index\.js') -or
        ($_.CommandLine -match 'src/index\.js')
      )
    } |
    Sort-Object CreationDate -Descending |
    Select-Object -First 1
  
  if ($null -eq $nodeProc -and $attempt -lt $maxAttempts) {
    Write-Host "." -NoNewline -ForegroundColor Gray
  }
}

if ($null -ne $nodeProc) {
  Write-Host "" # Nueva linea despues de los puntos
}

if ($null -eq $nodeProc) {
  Write-Host "" # Nueva linea
  Write-Status "No se pudo obtener el PID del proceso despues de $maxAttempts intentos." "WARNING"
  Write-Host "El bot puede estar iniciando. Espera unos segundos y usa 'status-bot.ps1' para verificar." -ForegroundColor Gray
  Write-Host "O verifica los logs en: $outLog" -ForegroundColor Gray
  # Limpiar script temporal
  Remove-Item $tempScript -Force -ErrorAction SilentlyContinue
  exit 0
}

$botPid = [int]$nodeProc.ProcessId

# Guardar PID
Set-Content -Path $pidFile -Value $botPid -Encoding ascii

# Limpiar script temporal
Remove-Item $tempScript -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Status "Bot iniciado exitosamente" "SUCCESS"
Write-Host "  PID:    $botPid" -ForegroundColor White
Write-Host "  Logs:   $outLog" -ForegroundColor Gray
Write-Host "  Errors: $errLog" -ForegroundColor Gray
Write-Host ""
Write-Host "Comandos utiles:" -ForegroundColor Cyan
Write-Host "  .\monitor-bot.ps1    - Monitorear el bot en tiempo real" -ForegroundColor Gray
Write-Host "  .\stop-bot.ps1       - Detener el bot" -ForegroundColor Gray
Write-Host "  .\restart-bot.ps1    - Reiniciar el bot" -ForegroundColor Gray

# Si se solicita, mostrar logs en vivo hasta que el usuario cierre
if ($Log) {
  Write-Host ""
  Write-Status "Mostrando logs en vivo (Ctrl+C para salir)..." "INFO"
  Write-Host "[OUT] -> $outLog" -ForegroundColor DarkGray
  Write-Host "[ERR] -> $errLog" -ForegroundColor DarkGray
  Write-Host ""
  try {
    $jobOut = Start-Job -ScriptBlock {
      Get-Content -Path $using:outLog -Wait -Tail 20 | ForEach-Object { 
        Write-Host "[OUT] $_" -ForegroundColor White
      }
    }
    $jobErr = Start-Job -ScriptBlock {
      Get-Content -Path $using:errLog -Wait -Tail 20 | ForEach-Object { 
        Write-Host "[ERR] $_" -ForegroundColor Red
      }
    }
    Write-Host "(Presiona Ctrl+C para salir sin detener el bot)" -ForegroundColor DarkGray
    Wait-Job -Any $jobOut,$jobErr | Out-Null
  } catch {
    Write-Status "No se pudo hacer seguimiento de logs: $($_.Exception.Message)" "WARNING"
  } finally {
    Stop-Job $jobOut,$jobErr -ErrorAction SilentlyContinue
    Remove-Job $jobOut,$jobErr -ErrorAction SilentlyContinue
  }
}

