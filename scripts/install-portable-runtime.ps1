param(
  [switch]$SkipNpm,
  [switch]$SkipPython,
  [switch]$SkipOpenCode,
  [switch]$SkipLibreOffice,
  [switch]$SkipMupdf,
  [switch]$SkipPoppler
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot
. (Join-Path $PSScriptRoot 'project-env.ps1')
Import-Ai4esProjectEnv $ProjectRoot

function Write-Step([string]$Message) {
  Write-Host "[portable] $Message" -ForegroundColor Cyan
}

function Resolve-BootstrapPython {
  if ($env:AI4ES_BOOTSTRAP_PYTHON) {
    $candidate = if ([IO.Path]::IsPathRooted([string]$env:AI4ES_BOOTSTRAP_PYTHON)) {
      [IO.Path]::GetFullPath([string]$env:AI4ES_BOOTSTRAP_PYTHON)
    } else {
      [IO.Path]::GetFullPath((Join-Path $ProjectRoot ([string]$env:AI4ES_BOOTSTRAP_PYTHON)))
    }
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $command = Get-Command python -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw 'Python 3.12 was not found. Install it or set AI4ES_BOOTSTRAP_PYTHON.'
}

function Ensure-Venv([string]$Name, [string]$Requirements) {
  $venv = Join-Path $ProjectRoot "tools\$Name"
  $python = Join-Path $venv 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $python)) {
    Write-Step "creating tools/$Name"
    & $script:BootstrapPython -m venv $venv
  }
  & $python -m pip install --disable-pip-version-check -r $Requirements
  if ($LASTEXITCODE -ne 0) { throw "Dependency install failed for $Name" }
}

if (-not $SkipNpm) {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm was not found in PATH.' }
  Write-Step 'installing locked Node.js dependencies'
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
}

if (-not $SkipOpenCode) {
  Write-Step 'installing project-local OpenCode and ripgrep'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'opencode-sidecar.ps1') install
  if ($LASTEXITCODE -ne 0) { throw 'OpenCode install failed.' }
}

if (-not $SkipPython) {
  $script:BootstrapPython = Resolve-BootstrapPython
  Ensure-Venv 'esopt-venv' (Join-Path $ProjectRoot 'tools\esopt\requirements.txt')
  Ensure-Venv 'tdmg-venv' (Join-Path $ProjectRoot 'tools\tdmg-acopf-dispatch\requirements.txt')
  Ensure-Venv 'pdf2md-venv' (Join-Path $ProjectRoot 'tools\pdf2md\requirements.txt')
  Ensure-Venv 'caj2pdf-venv' (Join-Path $ProjectRoot 'tools\caj2pdf-fresh\caj2pdf-master\requirements.txt')
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'power-compute-sidecars.ps1') -Action install -Target all
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ppt-voice-sidecar.ps1') install
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'mgplan-sidecar.ps1') -Action install
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'openmodelica-gateway.ps1') -Operation install
  & (Join-Path $ProjectRoot 'tools\markitdown.cmd') --version
  & $script:BootstrapPython (Join-Path $ProjectRoot 'tools\office-docs\run.py') --ensure
}

if (-not $SkipLibreOffice) {
  Write-Step 'unpacking portable LibreOffice for document page previews'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-libreoffice.ps1')
  if ($LASTEXITCODE -ne 0) { Write-Warning 'LibreOffice unpack failed; render.py will fall back to Office COM.' }
}

if (-not $SkipMupdf) {
  Write-Step 'downloading official MuPDF (mutool) for CAJ conversion'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-mupdf.ps1')
  if ($LASTEXITCODE -ne 0) { Write-Warning 'MuPDF download failed; CAJ conversion needs mutool on PATH.' }
}

if (-not $SkipPoppler) {
  Write-Step 'downloading Poppler (pdftoppm) for PDF page images'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-poppler.ps1')
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Poppler download failed; set PDFTOPPM_PATH or install Poppler.' }
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ensure-empty-corpus.ps1')

New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'storage') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot '数据') | Out-Null
Write-Host '[portable] project-local runtime is ready.' -ForegroundColor Green
