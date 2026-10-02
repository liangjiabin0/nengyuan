# Downloads Poppler for Windows (pdftoppm) from the public GitHub release.
# https://github.com/oschwartz10612/poppler-windows

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $ProjectRoot 'tools\poppler'
$existing = Get-ChildItem -LiteralPath $Target -Recurse -Filter pdftoppm.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existing) {
  Write-Host "[poppler] already present: $($existing.FullName)"
  exit 0
}

$release = Invoke-RestMethod -Headers @{ 'User-Agent' = 'ai4es-poppler-installer' } `
  -Uri 'https://api.github.com/repos/oschwartz10612/poppler-windows/releases/latest'
$asset = @($release.assets) | Where-Object { $_.name -like 'Release-*.zip' } | Select-Object -First 1
if (-not $asset) { throw 'Poppler release has no Release-*.zip asset.' }

New-Item -ItemType Directory -Force -Path $Target | Out-Null
$zip = Join-Path $env:TEMP $asset.name
Write-Host "[poppler] downloading $($asset.browser_download_url)"
Invoke-WebRequest -Headers @{ 'User-Agent' = 'ai4es-poppler-installer' } `
  -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
Expand-Archive -LiteralPath $zip -DestinationPath $Target -Force
$found = Get-ChildItem -LiteralPath $Target -Recurse -Filter pdftoppm.exe | Select-Object -First 1
if (-not $found) { throw "pdftoppm.exe missing after extracting $($asset.name)" }
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
Write-Host "[poppler] ready: $($found.FullName)" -ForegroundColor Green
