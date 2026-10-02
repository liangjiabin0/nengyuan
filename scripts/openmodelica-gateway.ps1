param(
  [ValidateSet('install', 'start', 'stop', 'status')]
  [Alias('Action')]
  [string]$Operation = 'status'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'project-env.ps1')
Import-Ai4esProjectEnv $root
$tool = Join-Path $root 'tools\openmodelica-gateway'
$venv = Join-Path $root 'tools\openmodelica-gateway-venv'
$python = Join-Path $venv 'Scripts\python.exe'
$pidFile = Join-Path $root 'storage\openmodelica-gateway.pid'
$url = if ($env:OPENMODELICA_GATEWAY_URL) { $env:OPENMODELICA_GATEWAY_URL } else { 'http://127.0.0.1:18088' }
$port = if ($env:OMG_PORT) { [int]$env:OMG_PORT } else { ([Uri]$url).Port }
$stdoutPath = Join-Path $root 'storage\openmodelica-gateway.out.log'
$stderrPath = Join-Path $root 'storage\openmodelica-gateway.err.log'

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

function Find-Omc {
  if ($env:OPENMODELICA_OMC) {
    $configured = if ([IO.Path]::IsPathRooted([string]$env:OPENMODELICA_OMC)) {
      [IO.Path]::GetFullPath([string]$env:OPENMODELICA_OMC)
    } else {
      [IO.Path]::GetFullPath((Join-Path $root ([string]$env:OPENMODELICA_OMC)))
    }
    if (Test-Path -LiteralPath $configured) { return $configured }
  }
  $cmd = Get-Command omc -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'OpenModelica\bin\omc.exe' }),
    'C:\Program Files\OpenModelica\bin\omc.exe'
  ) | Where-Object { $_ }
  foreach ($item in $candidates) {
    if (Test-Path $item) { return $item }
  }
  $searchRoots = @($env:ProgramFiles, $env:LOCALAPPDATA) | Where-Object { $_ -and (Test-Path $_) }
  $hits = Get-ChildItem $searchRoots -Filter 'omc.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hits) { return $hits.FullName }
  return $null
}

function Test-Gateway {
  try {
    $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

if ('install' -eq $Operation) {
  $launcher = Resolve-Python
  if (-not (Test-Path $venv)) { & $launcher -m venv $venv }
  & $python -m pip install --upgrade pip
  & $python -m pip install -r (Join-Path $tool 'requirements.txt')
  & $python -m pip install OMPython
  $omc = Find-Omc
  if (-not $omc) {
    Write-Host 'Python gateway dependencies are installed, but omc was not found. Install OpenModelica or use Docker.'
  } else {
    Write-Host "Installed gateway venv. omc=$omc"
  }
  return
}

if ('start' -eq $Operation) {
  if (-not (Test-Path $python)) { throw 'Run npm run modelica:install first.' }
  if (Test-Gateway) {
    Write-Host "OpenModelica gateway already running: $url"
    return
  }
  $omc = Find-Omc
  if (-not $omc) { throw 'omc was not found; the real simulation gateway cannot start.' }
  $omHome = Split-Path (Split-Path $omc)
  $dataDir = Join-Path $root 'storage\openmodelica-gateway\data'
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Split-Path $pidFile) | Out-Null
  if (Test-Path $pidFile) {
    $stalePid = [int](Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $stalePid -or -not (Get-Process -Id $stalePid -ErrorAction SilentlyContinue)) {
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
  $env:PATH = "$(Split-Path $omc);$env:PATH"
  $env:OPENMODELICAHOME = $omHome
  $env:OMG_DATA_DIR = $dataDir
  $env:PYTHONUTF8 = '1'
  $env:PYTHONIOENCODING = 'utf-8'
  if (-not $env:OMG_API_KEY) { $env:OMG_API_KEY = 'change-me' }
  $proc = Start-Process -FilePath $python `
    -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$port") `
    -WorkingDirectory $tool `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru `
    -WindowStyle Hidden
  Set-Content -Path $pidFile -Value $proc.Id
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-Gateway) {
      Write-Host "OpenModelica gateway started pid=$($proc.Id) $url"
      return
    }
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  $detail = if (Test-Path $stderrPath) {
    (Get-Content $stderrPath -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
  } else {
    'No gateway error log was written.'
  }
  throw "OpenModelica gateway failed to become healthy. $detail"
}

if ('stop' -eq $Operation) {
  if (Test-Path $pidFile) {
    $procId = Get-Content $pidFile
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -Force
    Write-Host "Stopped $procId"
  } else {
    Write-Host 'No pid file.'
  }
  return
}

try {
  $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2
  Write-Host ($health | ConvertTo-Json -Compress)
} catch {
  Write-Host "gateway down: $($_.Exception.Message)"
}
$omc = Find-Omc
Write-Host "omc=$(if ($omc) { $omc } else { 'missing' })"
