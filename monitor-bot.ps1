# Script para monitorear el estado del bot en tiempo real
# Muestra logs, uso de memoria y estado del proceso

$ErrorActionPreference = "SilentlyContinue"

# Colores
$COLOR_SUCCESS = @{ ForegroundColor = 'Green' }
$COLOR_WARNING = @{ ForegroundColor = 'Yellow' }
$COLOR_ERROR = @{ ForegroundColor = 'Red' }
$COLOR_INFO = @{ ForegroundColor = 'Cyan' }

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

function Get-BotStatus {
    $indexPath = Join-Path $scriptDir 'src\index.js'
    $absEsc = [Regex]::Escape($indexPath)
    
    $proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -match '(?i)^node(\.exe)?$' -and (
          ($_.CommandLine -match $absEsc) -or
          ($_.CommandLine -match 'src\\index\.js') -or
          ($_.CommandLine -match 'src/index\.js')
        )
      } | Select-Object -First 1
    
    if ($proc) {
        $process = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
        if ($process) {
            $memoryMB = [math]::Round($process.WorkingSet / 1MB, 2)
            $cpuPercent = [math]::Round($process.CPU, 2)
            $uptime = (Get-Date) - $process.StartTime
            
            $uptimeStr = if ($uptime.Days -gt 0) {
                "{0}d {1}h {2}m" -f $uptime.Days, $uptime.Hours, $uptime.Minutes
            } elseif ($uptime.Hours -gt 0) {
                "{0}h {1}m {2}s" -f $uptime.Hours, $uptime.Minutes, $uptime.Seconds
            } elseif ($uptime.Minutes -gt 0) {
                "{0}m {1}s" -f $uptime.Minutes, $uptime.Seconds
            } else {
                "{0}s" -f $uptime.Seconds
            }
            
            # Calcular uso de CPU en porcentaje (aproximado)
            $cpuUsage = [math]::Round(($process.CPU / $uptime.TotalSeconds), 2)
            
            return @{
                Running = $true
                Memory = "$memoryMB MB"
                CPU = "$cpuPercent s"
                CPUPercent = "$cpuUsage%"
                Uptime = $uptimeStr
                PID = $process.Id
                StartTime = $process.StartTime.ToString("yyyy-MM-dd HH:mm:ss")
            }
        }
    }
    
    return @{
        Running = $false
    }
}

function Show-Header {
    Clear-Host
    Write-Host "===========================================================" -ForegroundColor Cyan
    Write-Host "              MONITOR DEL BOT DE DISCORD" -ForegroundColor Cyan
    Write-Host "===========================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Actualizacion automatica cada 5 segundos" -ForegroundColor Gray
    Write-Host "  ultima actualizacion: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
    Write-Host ""
}

function Show-Status {
    param($status)
    
    Write-Host "Estado del Bot:" -ForegroundColor White
    Write-Host ""
    
    if ($status.Running) {
        Write-Host "  Estado:       " -NoNewline -ForegroundColor White
        Write-Host "[ACTIVO]" -ForegroundColor Green
        Write-Host "  PID:          " -NoNewline -ForegroundColor White
        Write-Host $status.PID -ForegroundColor Yellow
        Write-Host "  Memoria RAM:  " -NoNewline -ForegroundColor White
        Write-Host $status.Memory -ForegroundColor White
        Write-Host "  CPU (total):  " -NoNewline -ForegroundColor White
        Write-Host $status.CPU -ForegroundColor White
        Write-Host "  CPU (uso):    " -NoNewline -ForegroundColor White
        Write-Host $status.CPUPercent -ForegroundColor White
        Write-Host "  Uptime:       " -NoNewline -ForegroundColor White
        Write-Host $status.Uptime -ForegroundColor White
        Write-Host "  Iniciado:     " -NoNewline -ForegroundColor White
        Write-Host $status.StartTime -ForegroundColor Gray
    } else {
        Write-Host "  Estado:       " -NoNewline -ForegroundColor White
        Write-Host "[INACTIVO]" -ForegroundColor Red
        Write-Host ""
        Write-Host "  El bot no esta ejecutandose" -ForegroundColor Yellow
        Write-Host "  Ejecuta '.\run-bot-bg.ps1' para iniciarlo" -ForegroundColor Gray
    }
    Write-Host ""
    Write-Host "-----------------------------------------------------------" -ForegroundColor Gray
}

function Show-RecentLogs {
    Write-Host ""
    Write-Host "Logs Recientes (ultimas 15 lineas):" -ForegroundColor Cyan
    Write-Host ""
    
    $logPath = Join-Path $scriptDir 'logs\bot.out.log'
    if (Test-Path $logPath) {
        Get-Content $logPath -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object {
            $line = $_
            # Colorear segun el contenido
            if ($line -match "\[healthcheck\]|\[health\]") {
                Write-Host "  $line" -ForegroundColor Green
            } elseif ($line -match "\[cleanup\]") {
                Write-Host "  $line" -ForegroundColor Blue
            } elseif ($line -match "\[voice\]") {
                Write-Host "  $line" -ForegroundColor Magenta
            } elseif ($line -match "\[player\]") {
                Write-Host "  $line" -ForegroundColor Cyan
            } elseif ($line -match "error|Error|ERROR") {
                Write-Host "  $line" -ForegroundColor Red
            } elseif ($line -match "warn|Warn|WARN|warning") {
                Write-Host "  $line" -ForegroundColor Yellow
            } elseif ($line -match "success|Success|SUCCESS|OK") {
                Write-Host "  $line" -ForegroundColor Green
            } else {
                Write-Host "  $line" -ForegroundColor White
            }
        }
    } else {
        Write-Host "  No hay logs disponibles" -ForegroundColor Yellow
    }
    
    Write-Host ""
    Write-Host "-----------------------------------------------------------" -ForegroundColor Gray
}

function Show-RecentErrors {
    Write-Host ""
    Write-Host "Errores Recientes (ultimas 5 lineas):" -ForegroundColor Yellow
    Write-Host ""
    
    $errPath = Join-Path $scriptDir 'logs\bot.err.log'
    if (Test-Path $errPath) {
        $errors = Get-Content $errPath -Tail 5 -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne "" }
        if ($errors) {
            $errors | ForEach-Object {
                Write-Host "  $_" -ForegroundColor Red
            }
        } else {
            Write-Host "  [OK] No hay errores recientes" -ForegroundColor Green
        }
    } else {
        Write-Host "  [OK] No hay archivo de errores" -ForegroundColor Green
    }
    
    Write-Host ""
}

# Menu de opciones
function Show-Menu {
    Write-Host ""
    Write-Host "Opciones:" -ForegroundColor Cyan
    Write-Host "  [R] Refrescar ahora" -ForegroundColor White
    Write-Host "  [L] Ver logs completos" -ForegroundColor White
    Write-Host "  [E] Ver errores completos" -ForegroundColor White
    Write-Host "  [C] Limpiar archivos de log" -ForegroundColor White
    Write-Host "  [S] Detener bot" -ForegroundColor White
    Write-Host "  [T] Reiniciar bot" -ForegroundColor White
    Write-Host "  [Q] Salir del monitor" -ForegroundColor White
    Write-Host ""
    Write-Host "Selecciona una opcion o espera 5s para auto-refrescar: " -NoNewline -ForegroundColor Yellow
}

# Mensaje inicial
Write-Host ""
Write-Host "===========================================================" -ForegroundColor Cyan
Write-Host "    Iniciando monitor del bot..." -ForegroundColor Cyan
Write-Host "===========================================================" -ForegroundColor Cyan
Start-Sleep -Milliseconds 500

# Loop principal
$continue = $true
$autoRefreshSeconds = 5

while ($continue) {
    Show-Header
    $status = Get-BotStatus
    Show-Status $status
    Show-RecentLogs
    Show-RecentErrors
    Show-Menu
    
    # Esperar input con timeout
    $startTime = Get-Date
    $keyPressed = $false
    $key = $null
    
    while (((Get-Date) - $startTime).TotalSeconds -lt $autoRefreshSeconds -and -not $keyPressed) {
        if ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            $keyPressed = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    
    if (-not $keyPressed) {
        # Auto-refresh
        continue
    }
    
    $action = $key.KeyChar.ToString().ToUpper()
    
    switch ($action) {
        "R" {
            # Refrescar (hacer nada, el loop se reinicia)
        }
        "L" {
            Clear-Host
            Write-Host "===========================================================" -ForegroundColor Cyan
            Write-Host "                    LOGS COMPLETOS" -ForegroundColor Cyan
            Write-Host "===========================================================" -ForegroundColor Cyan
            Write-Host ""
            $logPath = Join-Path $scriptDir 'logs\bot.out.log'
            if (Test-Path $logPath) {
                Get-Content $logPath | ForEach-Object {
                    $line = $_
                    if ($line -match "error|Error|ERROR") {
                        Write-Host $line -ForegroundColor Red
                    } elseif ($line -match "warn|Warn|WARN|warning") {
                        Write-Host $line -ForegroundColor Yellow
                    } else {
                        Write-Host $line
                    }
                }
            } else {
                Write-Host "No hay logs disponibles" -ForegroundColor Yellow
            }
            Write-Host ""
            Write-Host "Presiona cualquier tecla para volver..." -ForegroundColor Yellow
            [Console]::ReadKey($true) | Out-Null
        }
        "E" {
            Clear-Host
            Write-Host "===========================================================" -ForegroundColor Cyan
            Write-Host "                   ERRORES COMPLETOS" -ForegroundColor Cyan
            Write-Host "===========================================================" -ForegroundColor Cyan
            Write-Host ""
            $errPath = Join-Path $scriptDir 'logs\bot.err.log'
            if (Test-Path $errPath) {
                Get-Content $errPath | ForEach-Object {
                    Write-Host $_ -ForegroundColor Red
                }
            } else {
                Write-Host "No hay errores disponibles" -ForegroundColor Green
            }
            Write-Host ""
            Write-Host "Presiona cualquier tecla para volver..." -ForegroundColor Yellow
            [Console]::ReadKey($true) | Out-Null
        }
        "C" {
            Clear-Host
            Write-Host "===========================================================" -ForegroundColor Cyan
            Write-Host "                 LIMPIANDO LOGS..." -ForegroundColor Cyan
            Write-Host "===========================================================" -ForegroundColor Cyan
            Write-Host ""
            $logPath = Join-Path $scriptDir 'logs\bot.out.log'
            $errPath = Join-Path $scriptDir 'logs\bot.err.log'
            if (Test-Path $logPath) {
                Clear-Content $logPath
                Write-Host "[OK] bot.out.log limpiado" -ForegroundColor Green
            }
            if (Test-Path $errPath) {
                Clear-Content $errPath
                Write-Host "[OK] bot.err.log limpiado" -ForegroundColor Green
            }
            Write-Host ""
            Write-Host "Presiona cualquier tecla para continuar..." -ForegroundColor Yellow
            [Console]::ReadKey($true) | Out-Null
        }
        "S" {
            Clear-Host
            Write-Host "===========================================================" -ForegroundColor Yellow
            Write-Host "                   DETENIENDO BOT..." -ForegroundColor Yellow
            Write-Host "===========================================================" -ForegroundColor Yellow
            Write-Host ""
            & "$scriptDir\stop-bot.ps1"
            Write-Host ""
            Write-Host "Presiona cualquier tecla para continuar..." -ForegroundColor Yellow
            [Console]::ReadKey($true) | Out-Null
        }
        "T" {
            Clear-Host
            Write-Host "===========================================================" -ForegroundColor Yellow
            Write-Host "                   REINICIANDO BOT..." -ForegroundColor Yellow
            Write-Host "===========================================================" -ForegroundColor Yellow
            Write-Host ""
            & "$scriptDir\restart-bot.ps1"
            Write-Host ""
            Write-Host "Presiona cualquier tecla para continuar..." -ForegroundColor Yellow
            [Console]::ReadKey($true) | Out-Null
        }
        "Q" {
            $continue = $false
            Write-Host ""
            Write-Host "===========================================================" -ForegroundColor Cyan
            Write-Host "    Saliendo del monitor..." -ForegroundColor Cyan
            Write-Host "===========================================================" -ForegroundColor Cyan
            Write-Host ""
        }
    }
}

