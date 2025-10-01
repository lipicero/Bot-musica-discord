# Script para monitorear el estado del bot en tiempo real
# Muestra logs, uso de memoria y estado del proceso

$ErrorActionPreference = "SilentlyContinue"

function Get-BotStatus {
    $process = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "" }
    
    if ($process) {
        $memoryMB = [math]::Round($process.WorkingSet / 1MB, 2)
        $cpuPercent = [math]::Round($process.CPU, 2)
        $uptime = (Get-Date) - $process.StartTime
        $uptimeStr = "{0:dd}d {0:hh}h {0:mm}m" -f $uptime
        
        return @{
            Running = $true
            Memory = "$memoryMB MB"
            CPU = "$cpuPercent s"
            Uptime = $uptimeStr
            PID = $process.Id
        }
    } else {
        return @{
            Running = $false
        }
    }
}

function Show-Header {
    Clear-Host
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host "         Monitor del Bot de Discord                     " -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host ""
}

function Show-Status {
    param($status)
    
    if ($status.Running) {
        Write-Host "Estado: " -NoNewline -ForegroundColor White
        Write-Host "[ACTIVO]" -ForegroundColor Green
        Write-Host ""
        Write-Host "  PID:       $($status.PID)" -ForegroundColor White
        Write-Host "  Memoria:   $($status.Memory)" -ForegroundColor White
        Write-Host "  CPU:       $($status.CPU)" -ForegroundColor White
        Write-Host "  Uptime:    $($status.Uptime)" -ForegroundColor White
    } else {
        Write-Host "Estado: " -NoNewline -ForegroundColor White
        Write-Host "[INACTIVO]" -ForegroundColor Red
        Write-Host ""
        Write-Host "  El bot no esta ejecutandose" -ForegroundColor Yellow
        Write-Host "  Ejecuta 'run-bot-optimized.bat' para iniciarlo" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "--------------------------------------------------------" -ForegroundColor Gray
}

function Show-RecentLogs {
    Write-Host ""
    Write-Host "[Logs recientes - ultimas 15 lineas]" -ForegroundColor Cyan
    Write-Host ""
    
    if (Test-Path "logs\bot.out.log") {
        Get-Content "logs\bot.out.log" -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_ -match "\[healthcheck\]") {
                Write-Host $_ -ForegroundColor Green
            } elseif ($_ -match "\[cleanup\]") {
                Write-Host $_ -ForegroundColor Blue
            } elseif ($_ -match "\[voice\]") {
                Write-Host $_ -ForegroundColor Magenta
            } elseif ($_ -match "error|Error|ERROR") {
                Write-Host $_ -ForegroundColor Red
            } elseif ($_ -match "warn|Warn|WARN") {
                Write-Host $_ -ForegroundColor Yellow
            } else {
                Write-Host $_ -ForegroundColor White
            }
        }
    } else {
        Write-Host "  No hay logs disponibles" -ForegroundColor Yellow
    }
    
    Write-Host ""
    Write-Host "--------------------------------------------------------" -ForegroundColor Gray
}

function Show-RecentErrors {
    Write-Host ""
    Write-Host "[Errores recientes - ultimas 10 lineas]" -ForegroundColor Yellow
    Write-Host ""
    
    if (Test-Path "logs\bot.err.log") {
        $errors = Get-Content "logs\bot.err.log" -Tail 10 -ErrorAction SilentlyContinue
        if ($errors) {
            $errors | ForEach-Object {
                Write-Host $_ -ForegroundColor Red
            }
        } else {
            Write-Host "  [OK] No hay errores recientes" -ForegroundColor Green
        }
    } else {
        Write-Host "  No hay archivo de errores" -ForegroundColor Yellow
    }
    
    Write-Host ""
}

# Menu de opciones
function Show-Menu {
    Write-Host ""
    Write-Host "Opciones:" -ForegroundColor Cyan
    Write-Host "  [R] Refrescar" -ForegroundColor White
    Write-Host "  [L] Ver logs completos" -ForegroundColor White
    Write-Host "  [E] Ver errores completos" -ForegroundColor White
    Write-Host "  [C] Limpiar archivos de log" -ForegroundColor White
    Write-Host "  [Q] Salir" -ForegroundColor White
    Write-Host ""
    Write-Host "Selecciona una opción: " -NoNewline -ForegroundColor Yellow
}

# Loop principal
$continue = $true
while ($continue) {
    Show-Header
    $status = Get-BotStatus
    Show-Status $status
    Show-RecentLogs
    Show-RecentErrors
    Show-Menu
    
    $key = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    
    switch ($key.Character.ToString().ToUpper()) {
        "R" {
            # Refrescar (hacer nada, el loop se reinicia)
        }
        "L" {
            Clear-Host
            Write-Host "[Logs completos]" -ForegroundColor Cyan
            Write-Host ""
            if (Test-Path "logs\bot.out.log") {
                Get-Content "logs\bot.out.log"
            } else {
                Write-Host "No hay logs disponibles" -ForegroundColor Yellow
            }
            Write-Host ""
            Write-Host "Presiona cualquier tecla para volver..." -ForegroundColor Yellow
            $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null
        }
        "E" {
            Clear-Host
            Write-Host "[Errores completos]" -ForegroundColor Yellow
            Write-Host ""
            if (Test-Path "logs\bot.err.log") {
                Get-Content "logs\bot.err.log"
            } else {
                Write-Host "No hay errores disponibles" -ForegroundColor Green
            }
            Write-Host ""
            Write-Host "Presiona cualquier tecla para volver..." -ForegroundColor Yellow
            $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null
        }
        "C" {
            Clear-Host
            Write-Host "[Limpiando archivos de log...]" -ForegroundColor Cyan
            if (Test-Path "logs\bot.out.log") {
                Clear-Content "logs\bot.out.log"
                Write-Host "[OK] bot.out.log limpiado" -ForegroundColor Green
            }
            if (Test-Path "logs\bot.err.log") {
                Clear-Content "logs\bot.err.log"
                Write-Host "[OK] bot.err.log limpiado" -ForegroundColor Green
            }
            Write-Host ""
            Write-Host "Presiona cualquier tecla para continuar..." -ForegroundColor Yellow
            $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null
        }
        "Q" {
            $continue = $false
            Write-Host ""
            Write-Host "[*] Saliendo del monitor..." -ForegroundColor Cyan
        }
    }
}
