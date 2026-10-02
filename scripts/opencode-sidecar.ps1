param(
  [ValidateSet("install", "update", "start", "stop", "status", "restart")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'project-env.ps1')
Import-Ai4esProjectEnv $ProjectRoot
$StorageRoot = Join-Path $ProjectRoot "storage"
$ToolRoot = Join-Path $ProjectRoot "tools\opencode"
$ExePath = Join-Path $ToolRoot "opencode.exe"
$RipgrepRoot = Join-Path $ProjectRoot "tools\ripgrep"
$RipgrepPath = Join-Path $RipgrepRoot "rg.exe"
$StatePath = Join-Path $StorageRoot "opencode-sidecar.json"
$StdoutPath = Join-Path $StorageRoot "opencode-sidecar.out.log"
$StderrPath = Join-Path $StorageRoot "opencode-sidecar.err.log"
$GatewayScript = Join-Path $ProjectRoot "scripts\llm-gateway.mjs"
$GatewayStdoutPath = Join-Path $StorageRoot "llm-gateway.out.log"
$GatewayStderrPath = Join-Path $StorageRoot "llm-gateway.err.log"
$CorpusManifest = Join-Path $StorageRoot "knowledge-corpus\MANIFEST.md"

function ConvertTo-OpenCodeJsonPath([string]$Value) {
  if (-not $Value) { return $Value }
  return $Value.Replace('\', '/')
}

function Get-GatewayPort {
  if ($env:LLM_GATEWAY_PORT) { return [int]$env:LLM_GATEWAY_PORT }
  return 4098
}

function Get-GatewayUrl {
  $port = Get-GatewayPort
  return "http://127.0.0.1:$port/v1"
}

function Test-GatewayAlive([object]$State) {
  if ($null -eq $State -or -not $State.gatewayPid) { return $false }
  $process = Get-Process -Id ([int]$State.gatewayPid) -ErrorAction SilentlyContinue
  return $null -ne $process
}

function Test-GatewayHealth([string]$GatewayUrl) {
  try {
    $healthUrl = $GatewayUrl -replace '/v1/?$', '/health'
    $null = Invoke-RestMethod -TimeoutSec 2 -Uri $healthUrl
    return $true
  } catch {
    return $false
  }
}

function Stop-Gateway([object]$State) {
  if (Test-GatewayAlive $State) {
    Stop-Process -Id ([int]$State.gatewayPid) -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped LLM gateway process $($State.gatewayPid)"
  }
  # Fallback: kill leftovers by port
  $port = Get-GatewayPort
  try {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($listener in $listeners) {
      if ($listener.OwningProcess) {
        Stop-Process -Id ([int]$listener.OwningProcess) -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
    # Get-NetTCPConnection may be unavailable
  }
}

function Start-Gateway {
  if (-not (Test-Path $GatewayScript)) {
    throw "LLM gateway script missing: $GatewayScript"
  }
  $port = Get-GatewayPort
  $gatewayUrl = Get-GatewayUrl
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) {
    throw "node.exe not found in PATH; required for LLM gateway"
  }

  # Stop previous gateway
  $existing = Read-SidecarState
  Stop-Gateway $existing

  $env:LLM_GATEWAY_PORT = "$port"
  $env:LLM_GATEWAY_HOST = "127.0.0.1"
  $process = Start-Process -FilePath $node.Source `
    -ArgumentList @($GatewayScript) `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $GatewayStdoutPath `
    -RedirectStandardError $GatewayStderrPath `
    -WindowStyle Hidden `
    -PassThru

  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 100
    if (Test-GatewayHealth $gatewayUrl) {
      $ready = $true
      break
    }
    if ($process.HasExited) { break }
  }
  if (-not $ready) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "LLM gateway failed to become healthy on $gatewayUrl. See $GatewayStderrPath"
  }
  Write-Host "LLM gateway ready at $gatewayUrl (pid $($process.Id))"
  return @{
    pid = $process.Id
    url = $gatewayUrl
  }
}

function Read-SidecarState {
  if (-not (Test-Path $StatePath)) { return $null }
  try {
    return Get-Content -Raw -Encoding UTF8 $StatePath | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Protect-SidecarState {
  if (-not (Test-Path $StatePath)) { return }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $StatePath /inheritance:r /grant:r "${identity}:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to protect OpenCode sidecar state: $StatePath"
  }
}

function Test-ProcessAlive([object]$State) {
  if ($null -eq $State -or -not $State.pid) { return $false }
  $process = Get-Process -Id ([int]$State.pid) -ErrorAction SilentlyContinue
  if ($null -eq $process) { return $false }
  try {
    return [string]::Equals(
      [IO.Path]::GetFullPath($process.Path),
      [IO.Path]::GetFullPath([string]$State.executable),
      [StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return $false
  }
}

function New-SidecarPassword {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Install-OpenCode {
  param([switch]$Force)
  if ((Test-Path $ExePath) -and -not $Force) {
    Write-Output "OpenCode already installed: $ExePath"
    return
  }
  New-Item -ItemType Directory -Force -Path $ToolRoot | Out-Null
  $release = Invoke-RestMethod -Headers @{ "User-Agent" = "electrical-system-opencode-installer" } `
    -Uri "https://api.github.com/repos/anomalyco/opencode/releases/latest"
  $asset = $release.assets | Where-Object { $_.name -eq "opencode-windows-x64.zip" } | Select-Object -First 1
  if ($null -eq $asset) {
    throw "Latest OpenCode release does not contain opencode-windows-x64.zip"
  }
  $zipPath = Join-Path $env:TEMP "opencode-windows-x64.zip"
  $extractPath = Join-Path $env:TEMP "opencode-windows-x64"
  Remove-Item -Force -ErrorAction SilentlyContinue $zipPath
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $extractPath
  Invoke-WebRequest -Headers @{ "User-Agent" = "electrical-system-opencode-installer" } `
    -Uri $asset.browser_download_url -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  $downloaded = Get-ChildItem -Path $extractPath -Filter "opencode.exe" -Recurse | Select-Object -First 1
  if ($null -eq $downloaded) {
    throw "Downloaded OpenCode archive does not contain opencode.exe"
  }
  Copy-Item -Force $downloaded.FullName $ExePath
  Remove-Item -Force -ErrorAction SilentlyContinue $zipPath
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $extractPath
  $version = & $ExePath --version
  Write-Output "Installed OpenCode $version at $ExePath"
}

function Stop-SidecarProcessKeepState {
  $state = Read-SidecarState
  if (Test-ProcessAlive $state) {
    Stop-Process -Id ([int]$state.pid) -Force
    Write-Output "Stopped OpenCode sidecar process $($state.pid)"
  }
  Stop-Gateway $state
}

function Install-Ripgrep {
  if (Test-Path $RipgrepPath) {
    Write-Output "ripgrep already installed: $RipgrepPath"
    return
  }
  New-Item -ItemType Directory -Force -Path $RipgrepRoot | Out-Null
  $release = Invoke-RestMethod -Headers @{ "User-Agent" = "electrical-system-opencode-installer" } `
    -Uri "https://api.github.com/repos/BurntSushi/ripgrep/releases/latest"
  $asset = $release.assets |
    Where-Object { $_.name -match "x86_64-pc-windows-msvc\.zip$" } |
    Select-Object -First 1
  if ($null -eq $asset) {
    throw "Latest ripgrep release does not contain a Windows x64 archive"
  }
  $zipPath = Join-Path $env:TEMP "ripgrep-windows-x64.zip"
  $extractPath = Join-Path $env:TEMP "ripgrep-windows-x64"
  Remove-Item -Force -ErrorAction SilentlyContinue $zipPath
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $extractPath
  Invoke-WebRequest -Headers @{ "User-Agent" = "electrical-system-opencode-installer" } `
    -Uri $asset.browser_download_url -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  $downloaded = Get-ChildItem -Path $extractPath -Filter "rg.exe" -Recurse | Select-Object -First 1
  if ($null -eq $downloaded) {
    throw "Downloaded ripgrep archive does not contain rg.exe"
  }
  Copy-Item -Force $downloaded.FullName $RipgrepPath
  Remove-Item -Force -ErrorAction SilentlyContinue $zipPath
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $extractPath
  Write-Output "Installed $(& $RipgrepPath --version | Select-Object -First 1) at $RipgrepPath"
}

function Get-Health([object]$State) {
  if ($null -eq $State) { return $null }
  $pair = "$($State.username):$($State.password)"
  $token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
  try {
    return Invoke-RestMethod -TimeoutSec 3 -Headers @{ Authorization = "Basic $token" } `
      -Uri "$($State.baseUrl)/global/health"
  } catch {
    return $null
  }
}

function Start-Sidecar {
  if (-not (Test-Path $CorpusManifest)) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ensure-empty-corpus.ps1')
  }
  if (-not (Test-Path $CorpusManifest)) {
    throw "Markdown corpus is missing. Run the corpus export before starting OpenCode: $CorpusManifest"
  }
  if (-not (Test-Path $ExePath)) { Install-OpenCode }
  if (-not (Test-Path $RipgrepPath)) { Install-Ripgrep }
  New-Item -ItemType Directory -Force -Path $StorageRoot | Out-Null
  $existing = Read-SidecarState
  Protect-SidecarState
  if (Test-ProcessAlive $existing) {
    $health = Get-Health $existing
    $gatewayUrl = if ($existing.gatewayUrl) { [string]$existing.gatewayUrl } else { Get-GatewayUrl }
    $gatewayOk = Test-GatewayHealth $gatewayUrl
    $usesGateway = $null -ne $existing.PSObject.Properties['gatewayUrl'] -and [string]$existing.gatewayUrl
    $usesAgentToken = $null -ne $existing.PSObject.Properties['agentApiToken'] -and [string]$existing.agentApiToken
    if ($null -ne $health -and $health.healthy -and $gatewayOk -and $usesGateway -and $usesAgentToken) {
      Write-Output "OpenCode sidecar is already healthy at $($existing.baseUrl)"
      Write-Output "LLM gateway already healthy at $gatewayUrl"
      return
    }
    Write-Output "Restarting OpenCode sidecar to attach LLM gateway..."
    Stop-Process -Id ([int]$existing.pid) -Force -ErrorAction SilentlyContinue
    Stop-Gateway $existing
  }

  $port = if ($env:OPENCODE_SERVER_PORT) { [int]$env:OPENCODE_SERVER_PORT } else { 4097 }
  # Reuse prior sidecar credentials on restart to avoid Next.js 401 after password rotation.
  $username = "opencode"
  if ($env:OPENCODE_SERVER_USERNAME) {
    $username = $env:OPENCODE_SERVER_USERNAME
  } elseif ($null -ne $existing -and $existing.PSObject.Properties['username']) {
    $username = [string]$existing.username
  }
  if ($env:OPENCODE_SERVER_PASSWORD) {
    $password = $env:OPENCODE_SERVER_PASSWORD
  } elseif ($null -ne $existing -and $existing.PSObject.Properties['password'] -and $existing.password) {
    $password = [string]$existing.password
  } else {
    $password = New-SidecarPassword
  }
  if ($env:AI4ES_AGENT_API_TOKEN) {
    $agentApiToken = [string]$env:AI4ES_AGENT_API_TOKEN
  } elseif ($null -ne $existing -and $existing.PSObject.Properties['agentApiToken'] -and $existing.agentApiToken) {
    $agentApiToken = [string]$existing.agentApiToken
  } else {
    $agentApiToken = New-SidecarPassword
  }
  $env:OPENCODE_SERVER_USERNAME = $username
  $env:OPENCODE_SERVER_PASSWORD = $password
  $env:AI4ES_AGENT_API_TOKEN = $agentApiToken
  $env:OPENCODE_CONFIG = Join-Path $ProjectRoot "opencode.json"
  $env:OPENCODE_CONFIG_DIR = Join-Path $ProjectRoot ".opencode"
  $env:OPENCODE_SKILLS_DIR = ConvertTo-OpenCodeJsonPath (Join-Path $ProjectRoot ".opencode\skills")
  $agentsLink = Join-Path $StorageRoot ".opencode\agents"
  $agentsTarget = Join-Path $ProjectRoot ".opencode\agents"
  if (-not (Test-Path $agentsLink)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $StorageRoot ".opencode") | Out-Null
    cmd /c mklink /J "$agentsLink" "$agentsTarget" | Out-Null
  }
  $skillsLink = Join-Path $StorageRoot ".opencode\skills"
  $skillsTarget = Join-Path $ProjectRoot ".opencode\skills"
  if (-not (Test-Path $skillsLink)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $StorageRoot ".opencode") | Out-Null
    cmd /c mklink /J "$skillsLink" "$skillsTarget" | Out-Null
  }
  $env:Path = "$RipgrepRoot;$($env:Path)"
  # OpenCode always uses local gateway; upstream URL is read live from settings.json
  $gateway = Start-Gateway
  $env:KNOWLEDGE_QA_BASE_URL = [string]$gateway.url
  $esoptRootRaw = if ($env:ESOPT_ROOT) { [string]$env:ESOPT_ROOT } else { "tools\esopt" }
  $env:ESOPT_ROOT = if ([IO.Path]::IsPathRooted($esoptRootRaw)) {
    [IO.Path]::GetFullPath($esoptRootRaw)
  } else {
    [IO.Path]::GetFullPath((Join-Path $ProjectRoot $esoptRootRaw))
  }
  $esoptBridgeRaw = if ($env:ESOPT_BRIDGE) { [string]$env:ESOPT_BRIDGE } else { "tools\esopt\esopt_bridge" }
  $env:ESOPT_BRIDGE = if ([IO.Path]::IsPathRooted($esoptBridgeRaw)) {
    [IO.Path]::GetFullPath($esoptBridgeRaw)
  } else {
    [IO.Path]::GetFullPath((Join-Path $ProjectRoot $esoptBridgeRaw))
  }
  $esoptNativeRaw = if ($env:ESOPT_NATIVE_ROOT) { [string]$env:ESOPT_NATIVE_ROOT } else { "tools\esopt" }
  $env:ESOPT_NATIVE_ROOT = if ([IO.Path]::IsPathRooted($esoptNativeRaw)) {
    [IO.Path]::GetFullPath($esoptNativeRaw)
  } else {
    [IO.Path]::GetFullPath((Join-Path $ProjectRoot $esoptNativeRaw))
  }
  if (-not $env:ESOPT_PYTHON) {
    $pythonDefault = Join-Path $ProjectRoot "tools\esopt-venv\Scripts\python.exe"
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    $env:ESOPT_PYTHON = if (Test-Path $pythonDefault) {
      $pythonDefault
    } elseif ($pythonCommand) {
      $pythonCommand.Source
    } else {
      "python"
    }
  } elseif (-not [IO.Path]::IsPathRooted([string]$env:ESOPT_PYTHON)) {
    $env:ESOPT_PYTHON = [IO.Path]::GetFullPath((Join-Path $ProjectRoot ([string]$env:ESOPT_PYTHON)))
  }
  $env:ESOPT_ROOT = ConvertTo-OpenCodeJsonPath $env:ESOPT_ROOT
  $env:ESOPT_BRIDGE = ConvertTo-OpenCodeJsonPath $env:ESOPT_BRIDGE
  $env:ESOPT_NATIVE_ROOT = ConvertTo-OpenCodeJsonPath $env:ESOPT_NATIVE_ROOT
  $env:ESOPT_PYTHON = ConvertTo-OpenCodeJsonPath $env:ESOPT_PYTHON
  $env:ESOPT_MCP_LAUNCHER = ConvertTo-OpenCodeJsonPath (Join-Path $ProjectRoot "scripts\esopt-mcp.cmd")

  $process = Start-Process -FilePath $ExePath `
    -ArgumentList @("serve", "--hostname", "127.0.0.1", "--port", "$port") `
    -WorkingDirectory $StorageRoot `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -PassThru

  $state = [ordered]@{
    pid = $process.Id
    baseUrl = "http://127.0.0.1:$port"
    username = $username
    password = $password
    agentApiToken = $agentApiToken
    executable = $ExePath
    workingDirectory = $StorageRoot
    startedAt = [DateTime]::UtcNow.ToString("o")
    gatewayPid = $gateway.pid
    gatewayUrl = $gateway.url
  }
  $state | ConvertTo-Json | Set-Content -Encoding UTF8 $StatePath
  Protect-SidecarState

  $healthy = $false
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    $health = Get-Health ([pscustomobject]$state)
    if ($null -ne $health -and $health.healthy) {
      $healthy = $true
      Write-Output "OpenCode sidecar ready at $($state.baseUrl), version $($health.version)"
      break
    }
    if (-not (Test-ProcessAlive ([pscustomobject]$state))) { break }
  }
  if (-not $healthy) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Stop-Gateway ([pscustomobject]$state)
    throw "OpenCode sidecar failed to become healthy. See $StderrPath"
  }
  Write-Output "OpenCode workingDirectory=$($state.workingDirectory)"
  Write-Output "OpenCode model endpoint via gateway=$($state.gatewayUrl)"
  Write-Output "OpenCode executable=$($state.executable)"
}

function Stop-Sidecar {
  $state = Read-SidecarState
  if (Test-ProcessAlive $state) {
    Stop-Process -Id ([int]$state.pid) -Force
    Write-Output "Stopped OpenCode sidecar process $($state.pid)"
  } else {
    Write-Output "OpenCode sidecar is not running"
  }
  Stop-Gateway $state
  Remove-Item -Force -ErrorAction SilentlyContinue $StatePath
}

function Show-Status {
  $state = Read-SidecarState
  if (-not (Test-ProcessAlive $state)) {
    Write-Output (@{ running = $false; healthy = $false; gateway = $false } | ConvertTo-Json -Compress)
    return
  }
  $health = Get-Health $state
  $gatewayUrl = if ($state.gatewayUrl) { [string]$state.gatewayUrl } else { Get-GatewayUrl }
  Write-Output (@{
    running = $true
    healthy = [bool]($null -ne $health -and $health.healthy)
    version = if ($null -ne $health) { $health.version } else { $null }
    baseUrl = $state.baseUrl
    pid = $state.pid
    gateway = Test-GatewayHealth $gatewayUrl
    gatewayUrl = $gatewayUrl
    gatewayPid = $state.gatewayPid
  } | ConvertTo-Json -Compress)
}

switch ($Action) {
  "install" {
    Install-OpenCode
    Install-Ripgrep
  }
  "update" {
    $existing = Read-SidecarState
    $wasRunning = Test-ProcessAlive $existing
    if ($wasRunning) {
      Stop-SidecarProcessKeepState
    }
    Install-OpenCode -Force
    if ($wasRunning) {
      Start-Sidecar
    }
  }
  "start" { Start-Sidecar }
  "stop" { Stop-Sidecar }
  "status" { Show-Status }
  "restart" {
    Stop-Sidecar
    Start-Sidecar
  }
}
