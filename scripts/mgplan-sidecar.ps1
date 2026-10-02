param(
  [ValidateSet('install', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'project-env.ps1')
Import-Ai4esProjectEnv $root
$tool = Join-Path $root 'tools\mgplan'
$venv = Join-Path $root 'tools\mgplan-venv'
$python = Join-Path $venv 'Scripts\python.exe'

function Resolve-Python {
  if ($env:MGPLAN_BOOTSTRAP_PYTHON) {
    $candidate = if ([IO.Path]::IsPathRooted([string]$env:MGPLAN_BOOTSTRAP_PYTHON)) {
      [IO.Path]::GetFullPath([string]$env:MGPLAN_BOOTSTRAP_PYTHON)
    } else {
      [IO.Path]::GetFullPath((Join-Path $root ([string]$env:MGPLAN_BOOTSTRAP_PYTHON)))
    }
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw 'Python not found. Install Python 3.12 x64 and retry.'
}

function Set-MgplanEnvironment {
  $env:MGPLAN_ROOT = $tool
  $env:MGPLAN_PYTHON = $python
  $env:PYTHONPATH = @(
    (Join-Path $tool 'mgplan_agent'),
    (Join-Path $tool 'scripts'),
    $tool
  ) -join [IO.Path]::PathSeparator
  $env:PYTHONIOENCODING = 'utf-8'
  $env:MPLBACKEND = 'Agg'
}

if (-not (Test-Path (Join-Path $tool 'requirements.txt'))) {
  throw "MGPlan tool files are missing: $tool"
}

if ($Action -eq 'install') {
  $launcher = Resolve-Python
  if (-not (Test-Path $python)) {
    & $launcher -m venv $venv
  }
  & $python -m pip install --upgrade pip
  & $python -m pip install -r (Join-Path $tool 'requirements.txt')
  Write-Host "Installed MGPlan environment: $python"
}

if (-not (Test-Path $python)) {
  throw 'MGPlan virtual environment is missing. Run npm run mgplan:install.'
}

Set-MgplanEnvironment
& $python -u -m mgplan_agent health
if ($LASTEXITCODE -ne 0) {
  throw 'MGPlan health probe failed.'
}
