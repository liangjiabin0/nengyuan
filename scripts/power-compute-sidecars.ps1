param(
  [ValidateSet('install', 'status')]
  [string]$Action = 'install',
  [ValidateSet('dispatch', 'loss', 'forecast', 'all')]
  [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'project-env.ps1')
Import-Ai4esProjectEnv $root

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
  throw 'Python not found. Install Python 3.12 then retry.'
}

function Install-Venv([string]$Name, [string]$ToolDir, [string]$Requirements) {
  $venv = Join-Path $root "tools\$Name"
  $python = Join-Path $venv 'Scripts\python.exe'
  $launcher = Resolve-Python
  if (-not (Test-Path $python)) { & $launcher -m venv $venv }
  & $python -m pip install --upgrade pip
  if (Test-Path $Requirements) {
    & $python -m pip install -r $Requirements
  }
  Write-Host "Installed $Name -> $python"
}

function Show-Status([string]$VenvName, [string]$Module, [string]$ToolDir) {
  $python = Join-Path $root "tools\$VenvName\Scripts\python.exe"
  if (-not (Test-Path $python)) {
    Write-Host "$VenvName missing. Run npm run compute install scripts."
    return
  }
  $env:PYTHONPATH = $ToolDir
  & $python -m $Module health
}

$targets = @()
if ($Target -eq 'all') { $targets = @('dispatch', 'loss', 'forecast') } else { $targets = @($Target) }

foreach ($item in $targets) {
  if ($item -eq 'dispatch') {
    if ($Action -eq 'install') {
      Install-Venv 'power-dispatch-venv' (Join-Path $root 'tools\power-dispatch') (Join-Path $root 'tools\power-dispatch\requirements-full.txt')
    } else {
      Show-Status 'power-dispatch-venv' 'dispatch_agent' ((Join-Path $root 'tools\power-dispatch') + ';' + (Join-Path $root 'tools\power-dispatch\src'))
    }
  }
  if ($item -eq 'loss') {
    if ($Action -eq 'install') {
      Install-Venv 'nwxs-loss-venv' (Join-Path $root 'tools\nwxs-loss') (Join-Path $root 'tools\nwxs-loss\requirements.txt')
    } else {
      Show-Status 'nwxs-loss-venv' 'loss_agent' ((Join-Path $root 'tools\nwxs-loss') + ';' + (Join-Path $root 'tools\nwxs-loss\scripts'))
    }
  }
  if ($item -eq 'forecast') {
    if ($Action -eq 'install') {
      $req = Join-Path $root 'tools\pv-wind-load-forecast\requirements.txt'
      if (-not (Test-Path $req)) {
        @(
          'pandas>=2.0',
          'numpy>=1.26',
          'scikit-learn>=1.3',
          'matplotlib>=3.7'
        ) | Set-Content -Path $req -Encoding utf8
      }
      Install-Venv 'forecast-venv' (Join-Path $root 'tools\pv-wind-load-forecast') $req
    } else {
      Show-Status 'forecast-venv' 'forecast_agent' (Join-Path $root 'tools\pv-wind-load-forecast')
    }
  }
}
