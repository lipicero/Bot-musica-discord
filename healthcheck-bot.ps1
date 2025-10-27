# Script de healthcheck para el bot de Discord
# Verifica que el bot este funcionando correctamente

$ErrorActionPreference = 'SilentlyContinue'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Colores
$COLOR_SUCCESS = @{ ForegroundColor = 'Green' }
$COLOR_WARNING = @{ ForegroundColor = 'Yellow' }
$COLOR_ERROR = @{ ForegroundColor = 'Red' }
$COLOR_INFO = @{ ForegroundColor = 'Cyan' }

function Write-Check {
  param([string]$Message, [bool]$Passed, [string]$Details = "")
  if ($Passed) {
    Write-Host "[OK] $Message" @COLOR_SUCCESS
    if ($Details) {
      Write-Host "    $Details" -ForegroundColor Gray
    }
  } else {
    Write-Host "[ERROR] $Message" @COLOR_ERROR
    if ($Details) {
      Write-Host "    $Details" -ForegroundColor Gray
    }
  }
}

function Write-Info {
  param([string]$Message)
  Write-Host "[INFO] $Message" @COLOR_INFO
}

Write-Host ""
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host "           HEALTHCHECK DEL BOT DE DISCORD" -ForegroundColor Cyan
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host ""

$allChecks = @()

# 1. Verificar que Node.js este instalado
Write-Info "Verificando Node.js..."
$nodeInstalled = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
if ($nodeInstalled) {
  $nodeVersion = (node --version).Trim()
  Write-Check "Node.js instalado" $true $nodeVersion
} else {
  Write-Check "Node.js instalado" $false "No se encontro en el PATH"
}
$allChecks += $nodeInstalled

# 2. Verificar npm
Write-Info "Verificando npm..."
$npmInstalled = $null -ne (Get-Command npm -ErrorAction SilentlyContinue)
if ($npmInstalled) {
  $npmVersion = (npm --version).Trim()
  Write-Check "npm instalado" $true "v$npmVersion"
} else {
  Write-Check "npm instalado" $false "No se encontro en el PATH"
}
$allChecks += $npmInstalled

# 3. Verificar archivos principales
Write-Info "Verificando archivos del proyecto..."
$mainFile = Test-Path (Join-Path $scriptDir 'src\index.js')
Write-Check "Archivo principal (src\index.js)" $mainFile
$allChecks += $mainFile

$packageJson = Test-Path (Join-Path $scriptDir 'package.json')
Write-Check "Archivo package.json" $packageJson
$allChecks += $packageJson

# 4. Verificar node_modules
Write-Info "Verificando dependencias..."
$nodeModules = Test-Path (Join-Path $scriptDir 'node_modules')
Write-Check "Carpeta node_modules" $nodeModules $(if ($nodeModules) { "Dependencias instaladas" } else { "Ejecuta 'npm install'" })
$allChecks += $nodeModules

# 5. Verificar archivo .env o variables de entorno
Write-Info "Verificando configuracion..."
$envFile = Test-Path (Join-Path $scriptDir '.env')
$hasToken = $env:DISCORD_TOKEN -ne $null -and $env:DISCORD_TOKEN -ne ""
$hasClientId = $env:CLIENT_ID -ne $null -and $env:CLIENT_ID -ne ""

if ($envFile) {
  Write-Check "Archivo .env presente" $true
  # Verificar que tenga contenido minimo
  $envContent = Get-Content (Join-Path $scriptDir '.env') -Raw
  $hasTokenInFile = $envContent -match "DISCORD_TOKEN\s*="
  $hasClientIdInFile = $envContent -match "CLIENT_ID\s*="
  Write-Check "  - DISCORD_TOKEN configurado" $hasTokenInFile
  Write-Check "  - CLIENT_ID configurado" $hasClientIdInFile
  $allChecks += $hasTokenInFile
  $allChecks += $hasClientIdInFile
} elseif ($hasToken -and $hasClientId) {
  Write-Check "Variables de entorno configuradas" $true "DISCORD_TOKEN y CLIENT_ID en entorno"
  $allChecks += $true
} else {
  Write-Check "Configuracion del bot" $false "Falta archivo .env o variables de entorno"
  $allChecks += $false
}

# 6. Verificar proceso del bot
Write-Info "Verificando proceso del bot..."
$indexPath = Join-Path $scriptDir 'src\index.js'
$absEsc = [Regex]::Escape($indexPath)
$botProcess = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { 
    $_.Name -match '(?i)^node(\.exe)?$' -and (
      ($_.CommandLine -match $absEsc) -or
      ($_.CommandLine -match 'src\\index\.js') -or
      ($_.CommandLine -match 'src/index\.js')
    )
  } |
  Select-Object -First 1

if ($botProcess) {
  $process = Get-Process -Id $botProcess.ProcessId -ErrorAction SilentlyContinue
  $memoryMB = [math]::Round($process.WorkingSet / 1MB, 2)
  $uptime = (Get-Date) - $process.StartTime
  $uptimeStr = "{0}h {1}m {2}s" -f $uptime.Hours, $uptime.Minutes, $uptime.Seconds
  Write-Check "Bot ejecutandose" $true "PID $($botProcess.ProcessId), $memoryMB MB, Uptime: $uptimeStr"
  $allChecks += $true
} else {
  Write-Check "Bot ejecutandose" $false "No se detecto el proceso"
  $allChecks += $false
}

# 7. Verificar logs
Write-Info "Verificando logs..."
$logsDir = Join-Path $scriptDir 'logs'
$outLog = Join-Path $logsDir 'bot.out.log'
$errLog = Join-Path $logsDir 'bot.err.log'

$hasLogs = Test-Path $outLog
Write-Check "Archivo de logs (bot.out.log)" $hasLogs $(if ($hasLogs) { 
  $file = Get-Item $outLog
  "$([math]::Round($file.Length / 1KB, 2)) KB"
} else { "" })

if ($hasLogs) {
  # Verificar errores recientes en stderr
  $hasErrors = Test-Path $errLog
  if ($hasErrors) {
    $errContent = Get-Content $errLog -Tail 10 -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne "" }
    if ($errContent) {
      Write-Check "Sin errores recientes" $false "$($errContent.Count) lineas de error en las ultimas 10 entradas"
    } else {
      Write-Check "Sin errores recientes" $true
      $allChecks += $true
    }
  } else {
    Write-Check "Sin errores recientes" $true "No hay archivo de errores"
    $allChecks += $true
  }
  
  # Verificar ultima actividad en logs
  $lastLog = Get-Content $outLog -Tail 1 -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($lastLog) {
    $file = Get-Item $outLog
    $minutesSinceModified = [math]::Round(((Get-Date) - $file.LastWriteTime).TotalMinutes, 1)
    if ($minutesSinceModified -lt 5) {
      Write-Check "Actividad reciente en logs" $true "ultima modificacion hace $minutesSinceModified minutos"
      $allChecks += $true
    } else {
      Write-Check "Actividad reciente en logs" $false "Sin actividad desde hace $minutesSinceModified minutos"
      $allChecks += $false
    }
  }
}

# 8. Verificar carpeta temp/yt-cache
Write-Info "Verificando cache..."
$cacheDir = Join-Path $scriptDir 'temp\yt-cache'
$hasCache = Test-Path $cacheDir
if ($hasCache) {
  $cacheFiles = (Get-ChildItem $cacheDir -File -ErrorAction SilentlyContinue | Measure-Object).Count
  $cacheSizeMB = [math]::Round((Get-ChildItem $cacheDir -File -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1MB, 2)
  Write-Check "Cache de YouTube" $true "$cacheFiles archivos, $cacheSizeMB MB"
} else {
  Write-Check "Cache de YouTube" $true "Carpeta no creada (se creara al usarse)"
}

# Resumen final
Write-Host ""
Write-Host "-----------------------------------------------------------" -ForegroundColor Gray
Write-Host ""

$passedChecks = ($allChecks | Where-Object { $_ -eq $true }).Count
$totalChecks = $allChecks.Count
$percentage = [math]::Round(($passedChecks / $totalChecks) * 100, 0)

Write-Host "Resumen: " -NoNewline -ForegroundColor White
if ($percentage -ge 80) {
  Write-Host "$passedChecks/$totalChecks checks pasados ($percentage%)" -ForegroundColor Green
  Write-Host "Estado: " -NoNewline -ForegroundColor White
  Write-Host "SALUDABLE [OK]" -ForegroundColor Green
} elseif ($percentage -ge 50) {
  Write-Host "$passedChecks/$totalChecks checks pasados ($percentage%)" -ForegroundColor Yellow
  Write-Host "Estado: " -NoNewline -ForegroundColor White
  Write-Host "CON ADVERTENCIAS [WARN]" -ForegroundColor Yellow
} else {
  Write-Host "$passedChecks/$totalChecks checks pasados ($percentage%)" -ForegroundColor Red
  Write-Host "Estado: " -NoNewline -ForegroundColor White
  Write-Host "CRITICO [ERROR]" -ForegroundColor Red
}

Write-Host ""
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host ""

# Exit code segun el resultado
if ($percentage -ge 80) {
  exit 0
} elseif ($percentage -ge 50) {
  exit 1
} else {
  exit 2
}
