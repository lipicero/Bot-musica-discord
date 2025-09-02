<#
.SYNOPSIS
  Fusiona cookies Netscape de YouTube y Google en un solo archivo y genera el Base64 para YT_COOKIE_B64.

.DESCRIPTION
  - Acepta uno o más archivos en formato Netscape (como exporta "Get cookies.txt" o extensiones similares).
  - Deduplica por (domain, path, name); la última aparición gana.
  - Emite un cookies.txt con cabecera Netscape válida.
  - Opcionalmente copia el Base64 al portapapeles y/o lo guarda en un archivo.

.PARAMETER InputFiles
  Rutas de archivos Netscape a fusionar. Si no se especifican, busca en Descargas archivos que contengan "yt"/"you" y "goog" en el nombre.

.PARAMETER OutputFile
  Ruta del archivo de salida (Netscape). Por defecto: ./cookies.txt

.PARAMETER ToClipboard
  Si se indica, copia el Base64 del archivo de salida al portapapeles.

.PARAMETER OutBase64File
  Si se indica, guarda el Base64 en el archivo especificado.

.EXAMPLE
  # Fusionar dos archivos y copiar Base64
  .\merge-cookies.ps1 -InputFiles .\yt.txt, .\goog.txt -ToClipboard

.EXAMPLE
  # Buscar automáticamente en Descargas y generar cookies.txt + cookies.b64.txt
  .\merge-cookies.ps1 -OutBase64File .\cookies.b64.txt

.NOTES
  - Sólo formato Netscape (7 columnas separadas por TAB). Si detecta JSON o cabeceras HTTP, mostrará advertencia.
  - Asegúrate de incluir cookies de *.youtube.com y *.google.com relevantes: SID, HSID, SSID, SAPISID, __Secure-*, etc.
#>
[CmdletBinding()]
param(
  [Parameter(Position=0)]
  [string[]]$InputFiles,
  [Parameter(Position=1)]
  [string]$OutputFile = (Join-Path -Path (Get-Location) -ChildPath 'cookies.txt'),
  [switch]$ToClipboard,
  [string]$OutBase64File
)

function Get-DefaultCookieFiles {
  try {
    $dl = Join-Path $env:USERPROFILE 'Downloads'
    if (-not (Test-Path $dl)) { return @() }
    $candidates = Get-ChildItem -Path $dl -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '(cookie|cookies|yt|you|goog|google)' -and $_.Length -gt 0 }
    return $candidates | Select-Object -ExpandProperty FullName
  } catch { return @() }
}

function Read-NetscapeLines([string]$file) {
  if (-not (Test-Path $file)) { return @() }
  $raw = Get-Content -Raw -ErrorAction SilentlyContinue -Path $file
  if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
  # Detección simple de JSON
  if ($raw.TrimStart().StartsWith('{') -or $raw.TrimStart().StartsWith('[')) {
    Write-Warning "'$file' parece JSON, no formato Netscape. Omite o conviértelo antes."
    return @()
  }
  $lines = $raw -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^\s*#' }
  # Validar columnas (7 separadas por TAB)
  $valid = @()
  foreach ($l in $lines) {
    $p = $l -split "`t"
    if ($p.Length -ge 7) { $valid += ,$l } else {
      # Intento de normalizar si viene separado por espacios múltiples
      $p2 = $l -split "\s+"
      if ($p2.Length -ge 7) {
        $candidate = ($p2[0..6] -join "`t")
        $valid += ,$candidate
      } else {
        Write-Verbose "Línea ignorada (no 7 columnas): $l"
      }
    }
  }
  return $valid
}

function Merge-Netscape([string[]]$files) {
  $merged = @{}
  foreach ($f in $files) {
    $lines = Read-NetscapeLines $f
    foreach ($l in $lines) {
      $p = $l -split "`t"
      if ($p.Length -lt 7) { continue }
      $domain = $p[0]; $path = $p[2]; $name = $p[5]
      $key = "$domain`t$path`t$name"
      # La última entrada (último archivo) gana
      $merged[$key] = $l
    }
  }
  # Orden estable: dominio, path, nombre
  return ($merged.GetEnumerator() | Sort-Object { $_.Key } | ForEach-Object { $_.Value })
}

# 1) Resolver archivos de entrada
if (-not $InputFiles -or $InputFiles.Count -eq 0) {
  $InputFiles = Get-DefaultCookieFiles
}
if (-not $InputFiles -or $InputFiles.Count -eq 0) {
  Write-Error "No se encontraron archivos de cookies. Pasa -InputFiles o exporta cookies a Descargas."
  exit 1
}

# 2) Fusionar
$mergedLines = Merge-Netscape $InputFiles
if (-not $mergedLines -or $mergedLines.Count -eq 0) {
  Write-Error "No se encontraron líneas Netscape válidas en los archivos suministrados."
  exit 2
}

# 3) Escribir salida Netscape
"# Netscape HTTP Cookie File" | Set-Content -Path $OutputFile -Encoding UTF8
$mergedLines | Add-Content -Path $OutputFile -Encoding UTF8
Write-Host "Cookies fusionadas -> $OutputFile" -ForegroundColor Green

# 4) Base64 (si no se indica destino, escribir cookies.b64.txt junto a OutputFile)
try {
  $raw = Get-Content -Raw -Path $OutputFile -Encoding UTF8
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($raw))
  if (-not $OutBase64File -or [string]::IsNullOrWhiteSpace($OutBase64File)) {
    $OutBase64File = Join-Path -Path (Split-Path -Parent $OutputFile) -ChildPath 'cookies.b64.txt'
  }
  $b64 | Set-Content -Path $OutBase64File -Encoding ASCII
  Write-Host "Base64 guardado en $OutBase64File" -ForegroundColor Cyan
  if ($ToClipboard) {
    try {
      $b64 | Set-Clipboard
      Write-Host "Base64 copiado al portapapeles (YT_COOKIE_B64)." -ForegroundColor Cyan
    } catch {
      Write-Warning "No se pudo copiar al portapapeles: $($_.Exception.Message). Usa el archivo $OutBase64File."
    }
  }
  Write-Host "Ejemplo para ENV: YT_COOKIE_B64=<contenido de $OutBase64File>" -ForegroundColor DarkGray
} catch {
  Write-Warning "No se pudo generar Base64: $($_.Exception.Message)"
}
