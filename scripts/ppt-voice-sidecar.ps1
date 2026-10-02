param(
  [ValidateSet('install', 'status')]
  [string]$Action = 'install'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'project-env.ps1')
Import-Ai4esProjectEnv $root
$tool = Join-Path $root 'tools\ppt-voice'
$venv = Join-Path $root 'tools\ppt-voice-venv'
$python = Join-Path $venv 'Scripts\python.exe'
$requirements = Join-Path $tool 'requirements.txt'

function Resolve-Python {
  if ($env:AI4ES_BOOTSTRAP_PYTHON) {
    $candidate = if ([IO.Path]::IsPathRooted([string]$env:AI4ES_BOOTSTRAP_PYTHON)) {
      [IO.Path]::GetFullPath([string]$env:AI4ES_BOOTSTRAP_PYTHON)
    } else {
      [IO.Path]::GetFullPath((Join-Path $root ([string]$env:AI4ES_BOOTSTRAP_PYTHON)))
    }
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'Python not found. Install Python 3.12 then retry npm run ppt-voice:install'
}

if ($Action -eq 'status') {
  if (Test-Path $python) {
    & $python -c "import sys; print(sys.executable); print(sys.version)"
    $env:PYTHONPATH = "$(Join-Path $tool 'src');$tool"
    & $python -m ppt_voice_agent health
    exit $LASTEXITCODE
  }
  Write-Host 'ppt-voice venv missing. Run npm run ppt-voice:install'
  exit 1
}

$launcher = Resolve-Python
if (-not (Test-Path $python)) { & $launcher -m venv $venv }
& $python -m pip install --upgrade pip
& $python -m pip install -r $requirements
Write-Host "PPT voice sidecar installed: $python"
