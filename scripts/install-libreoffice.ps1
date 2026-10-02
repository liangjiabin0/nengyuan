param(
  [string]$Version = '26.2.6',
  [string]$Mirror = 'https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable'
)

# Unpacks LibreOffice into tools\libreoffice without a system install, so the
# docx / pptx / xlsx skills can render page images even where Word COM hangs
# or Office is absent. render.py and soffice.py look there first.

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Target = Join-Path $ProjectRoot 'tools\libreoffice'
$Soffice = Join-Path $Target 'program\soffice.com'

if (Test-Path -LiteralPath $Soffice) {
  Write-Host "[libreoffice] already present: $Soffice"
  exit 0
}

$work = Join-Path $env:TEMP "ai4es-libreoffice-$Version"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$msiName = "LibreOffice_${Version}_Win_x86-64.msi"
$msi = Join-Path $work $msiName
if (-not (Test-Path -LiteralPath $msi)) {
  $url = "$Mirror/$Version/win/x86_64/$msiName"
  Write-Host "[libreoffice] downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
}

# Administrative install (/a) only extracts the files: no admin rights, no registry.
$extract = Join-Path $work 'extract'
$log = Join-Path $work 'msiexec.log'
Write-Host "[libreoffice] extracting to $extract"
$process = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
  '/a', "`"$msi`"", '/qn', "TARGETDIR=`"$extract`"", '/L*v', "`"$log`""
)
if ($process.ExitCode -ne 0) { throw "msiexec /a failed with exit code $($process.ExitCode); see $log" }

Remove-Item -LiteralPath (Join-Path $extract $msiName) -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
# Copy, not Move-Item: TEMP and the project are often on different drives.
Copy-Item -LiteralPath $extract -Destination $Target -Recurse
if (-not (Test-Path -LiteralPath $Soffice)) { throw "soffice.com missing after extraction: $Soffice" }
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "[libreoffice] ready: $Soffice" -ForegroundColor Green
