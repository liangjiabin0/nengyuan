# Downloads the official MuPDF Windows build so CAJ conversion can call mutool.
# Public archive: https://mupdf.com/downloads/archive/

param([string]$Version = '1.25.2')

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $ProjectRoot 'tools\mupdf'
$Nested = Join-Path $Target "mupdf-$Version-windows\mutool.exe"
$Flat = Join-Path $Target 'mutool.exe'
if ((Test-Path -LiteralPath $Nested) -or (Test-Path -LiteralPath $Flat)) {
  if (-not (Test-Path -LiteralPath $Flat) -and (Test-Path -LiteralPath $Nested)) {
    Copy-Item -LiteralPath $Nested -Destination $Flat
  }
  Write-Host "[mupdf] already present"
  exit 0
}

New-Item -ItemType Directory -Force -Path $Target | Out-Null
$zip = Join-Path $env:TEMP "mupdf-$Version-windows.zip"
$url = "https://mupdf.com/downloads/archive/mupdf-$Version-windows.zip"
Write-Host "[mupdf] downloading $url"
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Expand-Archive -LiteralPath $zip -DestinationPath $Target -Force
$found = Get-ChildItem -LiteralPath $Target -Recurse -Filter mutool.exe | Select-Object -First 1
if (-not $found) { throw "mutool.exe missing after extracting $url" }
Copy-Item -LiteralPath $found.FullName -Destination $Flat -Force
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
Write-Host "[mupdf] ready: $Flat" -ForegroundColor Green
