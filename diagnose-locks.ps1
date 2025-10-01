# Script para diagnosticar procesos que tienen bloqueados los archivos de logs
# y limpiar procesos huerfanos del bot

$ErrorActionPreference = 'Continue'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "=== Diagnostico de Bloqueo de Archivos de Logs ===" -ForegroundColor Cyan
Write-Host ""

# Verificar archivos de logs
$logsDir = Join-Path $scriptDir 'logs'
$logFiles = @(
  'bot.out.log',
  'bot.err.log',
  'exceptions.log',
  'rejections.log'
)

Write-Host "Buscando procesos Node.js del bot..." -ForegroundColor Yellow
$nodePids = Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, StartTime

if ($nodePids) {
  Write-Host "Procesos Node.js encontrados:" -ForegroundColor Green
  $nodePids | ForEach-Object {
    Write-Host "  PID: $($_.Id) - Inicio: $($_.StartTime)"
  }
} else {
  Write-Host "No se encontraron procesos Node.js en ejecucion." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Verificando archivos de logs..." -ForegroundColor Yellow

foreach ($logFile in $logFiles) {
  $logPath = Join-Path $logsDir $logFile
  
  if (Test-Path $logPath) {
    $fileInfo = Get-Item $logPath
    Write-Host ""
    Write-Host "Archivo: $logFile" -ForegroundColor Cyan
    Write-Host "  Tamano: $([math]::Round($fileInfo.Length / 1KB, 2)) KB"
    Write-Host "  Ultima modificacion: $($fileInfo.LastWriteTime)"
    
    # Intentar detectar procesos que tienen el archivo abierto usando handle.exe si esta disponible
    $handleExe = Get-Command handle.exe -ErrorAction SilentlyContinue
    $handleExe64 = Get-Command handle64.exe -ErrorAction SilentlyContinue
    
    if ($handleExe -or $handleExe64) {
      $handleCmd = if ($handleExe64) { "handle64.exe" } else { "handle.exe" }
      Write-Host "  Procesos con el archivo abierto:" -ForegroundColor Yellow
      $handles = & $handleCmd -accepteula -nobanner $logPath 2>$null
      if ($handles) {
        $handles | ForEach-Object {
          if ($_ -match '(\S+)\s+pid:\s+(\d+)') {
            Write-Host "    PID: $($Matches[2]) - Proceso: $($Matches[1])" -ForegroundColor Red
          }
        }
      } else {
        Write-Host "    Ninguno (archivo disponible)" -ForegroundColor Green
      }
    } else {
      Write-Host "  [Instala Sysinternals Handle para detectar bloqueos]" -ForegroundColor DarkGray
    }
  } else {
    Write-Host ""
    Write-Host "Archivo: $logFile - NO EXISTE" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Verificando archivo PID del bot..." -ForegroundColor Yellow
$pidFile = Join-Path $scriptDir 'bot.pid'

if (Test-Path $pidFile) {
  try {
    $storedPid = [int](Get-Content $pidFile)
    $process = Get-Process -Id $storedPid -ErrorAction SilentlyContinue
    
    if ($process) {
      Write-Host "  PID almacenado: $storedPid - ACTIVO" -ForegroundColor Green
      Write-Host "  Nombre: $($process.ProcessName)"
      Write-Host "  Inicio: $($process.StartTime)"
    } else {
      Write-Host "  PID almacenado: $storedPid - INACTIVO (proceso huerfano)" -ForegroundColor Red
      Write-Host "  Limpiando archivo bot.pid..." -ForegroundColor Yellow
      Remove-Item $pidFile -Force
      Write-Host "  OK Archivo bot.pid eliminado" -ForegroundColor Green
    }
  } catch {
    Write-Host "  Error leyendo bot.pid: $_" -ForegroundColor Red
  }
} else {
  Write-Host "  No existe archivo bot.pid" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Fin del Diagnostico ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Acciones sugeridas:" -ForegroundColor Yellow
Write-Host "  1. Si hay procesos Node.js huerfanos, ejecuta: ./stop-bot.ps1"
Write-Host "  2. Si los logs estan bloqueados, cierra editores de texto que puedan tenerlos abiertos"
Write-Host "  3. Si persiste el error EBUSY, reinicia el bot con: ./restart-bot.ps1"
Write-Host "  4. Considera instalar Sysinternals Handle para diagnosticos avanzados"
Write-Host ""
