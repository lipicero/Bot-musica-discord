# Script para limpiar archivos de debug de ytdl-core
# Estos archivos se crean cuando ytdl-core falla al parsear el player de YouTube

Write-Host "Limpiando archivos *-player-script.js..." -ForegroundColor Cyan

$files = Get-ChildItem -Path . -Filter "*-player-script.js" -File
$count = $files.Count

if ($count -eq 0) {
    Write-Host "No hay archivos para limpiar" -ForegroundColor Green
} else {
    Write-Host "Encontrados: $count archivos" -ForegroundColor Yellow
    
    foreach ($file in $files) {
        Write-Host "  Eliminando: $($file.Name)" -ForegroundColor Gray
        Remove-Item $file.FullName -Force
    }
    
    Write-Host "$count archivos eliminados" -ForegroundColor Green
}

Write-Host ""
Write-Host "Estos archivos se crean cuando ytdl-core no puede parsear el player de YouTube" -ForegroundColor DarkGray
Write-Host "Puedes ejecutar este script periodicamente para limpiarlos" -ForegroundColor DarkGray
