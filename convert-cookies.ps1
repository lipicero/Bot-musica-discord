# Script para convertir cookies de Netscape (cookies.txt) a JSON (cookies.json)
# Uso: .\convert-cookies.ps1

Write-Host "🍪 Convertidor de Cookies Netscape -> JSON" -ForegroundColor Cyan
Write-Host ""

$netscapePath = "cookies.txt"
$jsonPath = "cookies.json"

if (-not (Test-Path $netscapePath)) {
    Write-Host "❌ Error: No se encuentra el archivo $netscapePath" -ForegroundColor Red
    Write-Host ""
    Write-Host "📝 Para obtener cookies:" -ForegroundColor Yellow
    Write-Host "   1. Instala la extensión 'Get cookies.txt LOCALLY' en Chrome/Edge"
    Write-Host "   2. Ve a https://www.youtube.com e inicia sesión"
    Write-Host "   3. Haz clic en el ícono de la extensión"
    Write-Host "   4. Guarda el archivo como 'cookies.txt' en esta carpeta"
    exit 1
}

Write-Host "📂 Leyendo $netscapePath..." -ForegroundColor Gray

$lines = Get-Content $netscapePath
$cookies = @()

foreach ($line in $lines) {
    # Ignorar comentarios y líneas vacías
    if ($line.StartsWith("#") -or [string]::IsNullOrWhiteSpace($line)) {
        continue
    }
    
    # Formato Netscape: domain flag path secure expiration name value
    $parts = $line -split "`t"
    
    if ($parts.Length -ge 7) {
        $domain = $parts[0]
        $path = $parts[2]
        $secure = $parts[3] -eq "TRUE"
        $expiration = [int64]$parts[4]
        $name = $parts[5]
        $value = $parts[6]
        
        # Solo procesar cookies de YouTube/Google
        if ($domain -like "*.youtube.com" -or $domain -like "*.google.com") {
            $cookie = [ordered]@{
                domain = $domain
                expirationDate = $expiration
                hostOnly = $false
                httpOnly = $name.StartsWith("__Secure-") -or $name -in @("LOGIN_INFO", "SSID", "HSID", "SIDCC", "PREF", "YSC")
                name = $name
                path = $path
                sameSite = if ($name -like "*3P*") { "no_restriction" } else { "unspecified" }
                secure = $secure
                session = $expiration -eq 0
                storeId = "0"
                value = $value
            }
            
            $cookies += $cookie
            Write-Host "  ✓ $name" -ForegroundColor Green
        }
    }
}

if ($cookies.Count -eq 0) {
    Write-Host ""
    Write-Host "❌ No se encontraron cookies válidas de YouTube" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "💾 Guardando $jsonPath con $($cookies.Count) cookies..." -ForegroundColor Gray

# Convertir a JSON con formato legible
$json = $cookies | ConvertTo-Json -Depth 10
$json | Set-Content $jsonPath -Encoding UTF8

Write-Host ""
Write-Host "✅ ¡Cookies convertidas exitosamente!" -ForegroundColor Green
Write-Host ""
Write-Host "📊 Resumen:" -ForegroundColor Cyan
Write-Host "   Total de cookies: $($cookies.Count)" -ForegroundColor White
Write-Host "   Archivo de salida: $jsonPath" -ForegroundColor White

# Mostrar cookies importantes
$importantCookies = @("LOGIN_INFO", "VISITOR_INFO1_LIVE", "SID", "__Secure-3PSID")
$found = $cookies | Where-Object { $_.name -in $importantCookies }

if ($found.Count -gt 0) {
    Write-Host ""
    Write-Host "🔑 Cookies importantes encontradas:" -ForegroundColor Yellow
    foreach ($c in $found) {
        $expDate = [DateTimeOffset]::FromUnixTimeSeconds($c.expirationDate).LocalDateTime
        Write-Host "   ✓ $($c.name) (expira: $expDate)" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "🔄 Siguiente paso: Reinicia el bot con .\restart-bot.ps1" -ForegroundColor Cyan
