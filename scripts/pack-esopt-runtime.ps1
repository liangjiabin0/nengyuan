param(
  [string]$Source = "",
  [string]$OutputDir = "",
  [switch]$SkipLargeCases,
  [switch]$Zip
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
if (-not $Source) {
  $Source = Join-Path $ProjectRoot "tools\esopt"
}
$Source = [IO.Path]::GetFullPath($Source)
if (-not (Test-Path -LiteralPath (Join-Path $Source "esopt_bridge\esopt_agent"))) {
  throw "不是有效的 ESOPT 根目录（缺少 esopt_bridge）：$Source"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $OutputDir) {
  $OutputDir = Join-Path $ProjectRoot "dist\esopt-runtime-$stamp"
}
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
if (Test-Path -LiteralPath $OutputDir) {
  Remove-Item -LiteralPath $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

function Copy-Tree([string]$Rel, [string[]]$ExcludeDir = @()) {
  $from = Join-Path $Source $Rel
  if (-not (Test-Path -LiteralPath $from)) { return }
  $to = Join-Path $OutputDir $Rel
  New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
  robocopy $from $to /E /NFL /NDL /NJH /NJS /nc /ns /np `
    /XD CMakeFiles __pycache__ .git $ExcludeDir | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $Rel (code $LASTEXITCODE)" }
}

function Copy-One([string]$Rel) {
  $from = Join-Path $Source $Rel
  if (-not (Test-Path -LiteralPath $from)) { return }
  $to = Join-Path $OutputDir $Rel
  New-Item -ItemType Directory -Force -Path (Split-Path $to) | Out-Null
  Copy-Item -LiteralPath $from -Destination $to -Force
}

# Runtime only. Do NOT copy mingw64, cmake zips, DCOPF.gz, or the 700MB SDK zip.
Copy-Tree "esopt_bridge" @()
Copy-Tree "work\DCOPF\cases"
Copy-Tree "src\install\bin"
Copy-One "src\install\include\model_highs.h"
Copy-One "ESOPT_API.md"
Copy-One "requirements.txt"
Copy-One "esopt.cmd"
Copy-One "esopt.sh"

$build = Join-Path $Source "work\DCOPF\build"
$buildOut = Join-Path $OutputDir "work\DCOPF\build"
New-Item -ItemType Directory -Force -Path $buildOut | Out-Null
Get-ChildItem -LiteralPath $build -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -match '\.(exe|dll)$' } |
  ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $buildOut $_.Name) -Force }

if ($SkipLargeCases) {
  Get-ChildItem -LiteralPath (Join-Path $OutputDir "work\DCOPF\cases") -Filter "*.json" |
    Where-Object { $_.Length -gt 2MB } |
    Remove-Item -Force
}

$readmeLines = @(
  "ESOPT runtime pack. Do not ship the 700MB desktop SDK.",
  "Exclude: mingw64, cmake zip, DCOPF.gz (Windows rebuild only).",
  "No libOptInterface.so in the pack; Linux uses highspy, not native esoptc.",
  "Windows: unzip to an ASCII path such as C:\esopt-runtime, pip install -r requirements.txt, then esopt.cmd solve case24",
  "Linux: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && ./esopt.sh solve case24",
  "Reference: case24 objective 58448.6, termination_status 7. Place this folder at tools/esopt for AI4ES."
)
Set-Content -LiteralPath (Join-Path $OutputDir "README-RUNTIME.txt") -Value $readmeLines -Encoding UTF8

Write-Host "输出: $OutputDir"
Get-ChildItem -LiteralPath $OutputDir -Recurse -File |
  Measure-Object -Property Length -Sum |
  ForEach-Object { Write-Host ("文件 {0} 个, {1:N1} MB" -f $_.Count, ($_.Sum / 1MB)) }

if ($Zip) {
  $zipPath = "$OutputDir.zip"
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -Path (Join-Path $OutputDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host ("zip: {0}  {1:N1} MB" -f $zipPath, ((Get-Item $zipPath).Length / 1MB))
}
