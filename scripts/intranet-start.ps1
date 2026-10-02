param(
  # dev (default) | prod (next start, requires npm run build)
  [ValidateSet('dev', 'prod')]
  [string]$Mode = 'dev',
  [switch]$LocalOnly
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing $Name. Install Node.js 20+ (x64) and reopen the terminal."
  }
}

function Write-Info([string]$Message) {
  Write-Host $Message -ForegroundColor Cyan
}

Assert-Command "node"
Assert-Command "npm"

$nodeModules = Join-Path $ProjectRoot "node_modules"
if (-not (Test-Path -LiteralPath $nodeModules)) {
  throw "Missing node_modules. Use intranet pack or run npm install."
}

$opencodeExe = Join-Path $ProjectRoot "tools\opencode\opencode.exe"
$ripgrepExe = Join-Path $ProjectRoot "tools\ripgrep\rg.exe"
if (-not (Test-Path -LiteralPath $opencodeExe) -or -not (Test-Path -LiteralPath $ripgrepExe)) {
  Write-Info "OpenCode/ripgrep missing, trying local install..."
  try {
    & npm run opencode:install
  } catch {
    throw "OpenCode/ripgrep missing and install failed."
  }
  if (-not (Test-Path -LiteralPath $opencodeExe) -or -not (Test-Path -LiteralPath $ripgrepExe)) {
    throw "OpenCode/ripgrep still missing."
  }
}

$corpusManifest = Join-Path $ProjectRoot "storage\knowledge-corpus\MANIFEST.md"
if (-not (Test-Path -LiteralPath $corpusManifest)) {
  throw "Missing corpus manifest: $corpusManifest"
}

Write-Info "Starting OpenCode sidecar..."
& npm run opencode:start
if ($LASTEXITCODE -ne 0) {
  throw "OpenCode sidecar failed to start."
}

$settingsPath = Join-Path $ProjectRoot "storage\settings.json"
$modelUrl = "http://10.1.4.166:11435/v1"
if (Test-Path -LiteralPath $settingsPath) {
  try {
    $settings = Get-Content -Raw -Encoding UTF8 $settingsPath | ConvertFrom-Json
    if ($settings.baseUrl) { $modelUrl = [string]$settings.baseUrl }
  } catch {
    # keep default
  }
}

$modeRaw = if ($env:AI4ES_MODE) { [string]$env:AI4ES_MODE } else { $Mode }
$useProd = $modeRaw -match '^(?i)prod(uction)?$'
if ($useProd) {
  $nextBuild = Join-Path $ProjectRoot ".next"
  if (-not (Test-Path -LiteralPath $nextBuild)) {
    throw "Prod mode requires npm run build first."
  }
}
$port = if ($env:PORT) { [int]$env:PORT } else { 3000 }
$apiPort = if ($env:API_PORT) { [int]$env:API_PORT } else { 4000 }
$opencodePort = 4097

# 防止重复 start:intranet：两个看门狗会互相杀端口，并把 WMI 进程扫描打满整机
$script:IntranetMutex = New-Object System.Threading.Mutex($false, "Global\AI4ES-intranet-$port-$apiPort")
$script:HasIntranetMutex = $false
try {
  $script:HasIntranetMutex = $script:IntranetMutex.WaitOne(0)
} catch {
  $script:HasIntranetMutex = $false
}
if (-not $script:HasIntranetMutex) {
  Write-Warning "Another intranet-start is already running on ports $port/$apiPort. Exiting."
  exit 0
}
# next dev 内存阈值；超过则主动重启，避免卡死在无响应状态
$webMaxMemoryMb = if ($env:AI4ES_WEB_MAX_MB) { [int]$env:AI4ES_WEB_MAX_MB } else { 2500 }
$webHealthFailLimit = 3

function Get-LanIPv4Addresses {
  $addrs = @()
  try {
    $addrs = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.PrefixOrigin -ne 'WellKnown'
      } |
      Select-Object -ExpandProperty IPAddress -Unique
  } catch {
    # fallback below
  }
  if (-not $addrs -or $addrs.Count -eq 0) {
    $addrs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -ExpandProperty IPAddress -Unique)
  }
  return @($addrs)
}

function Ensure-FirewallRule([int]$ListenPort) {
  $ruleName = "AI4ES-LAN-$ListenPort"
  try {
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $existing) {
      New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $ListenPort -Profile Any -ErrorAction Stop | Out-Null
      Write-Info "Firewall rule added: $ruleName (TCP $ListenPort)"
    }
  } catch {
    Write-Warning "Could not add firewall rule for TCP $ListenPort."
  }
}

function Test-HttpOk([string]$Url, [int]$TimeoutSec = 3) {
  try {
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
      $code = & curl.exe -sS -o NUL -w "%{http_code}" -m $TimeoutSec $Url 2>$null
      return ($code -match '^2\d\d$')
    }
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Test-HttpOkRetry([string]$Url, [int]$TimeoutSec = 3, [int]$Attempts = 3) {
  for ($i = 1; $i -le $Attempts; $i++) {
    if (Test-HttpOk $Url $TimeoutSec) { return $true }
    if ($i -lt $Attempts) { Start-Sleep -Milliseconds 400 }
  }
  return $false
}

function Get-ListenPid([int]$ListenPort) {
  $owner = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ -and $_ -ne 0 } |
    Select-Object -First 1
  if ($owner) { return [int]$owner }
  return 0
}

function Test-ProcessAlive([System.Diagnostics.Process]$Proc) {
  if (-not $Proc) { return $false }
  try {
    $Proc.Refresh()
    return -not $Proc.HasExited
  } catch {
    return $false
  }
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSec = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk $Url 3) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Get-Win32ProcessSnapshot {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Select-Object ProcessId, ParentProcessId, WorkingSetSize, CommandLine)
}

function Get-ChildPidMap($snapshot) {
  $map = @{}
  foreach ($p in @($snapshot)) {
    if (-not $p) { continue }
    $ppid = [int]$p.ParentProcessId
    if (-not $map.ContainsKey($ppid)) {
      $map[$ppid] = New-Object System.Collections.Generic.List[int]
    }
    [void]$map[$ppid].Add([int]$p.ProcessId)
  }
  return $map
}

function Stop-TreeByPid([int]$ProcessId, $snapshot = $null) {
  if ($ProcessId -le 0) { return }
  try {
    if (-not $snapshot) { $snapshot = Get-Win32ProcessSnapshot }
    $childMap = Get-ChildPidMap $snapshot
    $ids = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    $queue.Enqueue($ProcessId) | Out-Null
    while ($queue.Count -gt 0) {
      $current = $queue.Dequeue()
      if (-not $seen.Add($current)) { continue }
      [void]$ids.Add($current)
      if ($childMap.ContainsKey($current)) {
        foreach ($cid in $childMap[$current]) { $queue.Enqueue([int]$cid) }
      }
    }
    for ($i = $ids.Count - 1; $i -ge 0; $i--) {
      Stop-Process -Id $ids[$i] -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # ignore
  }
}

function Stop-ChildProcess($proc) {
  if (-not $proc) { return }
  try {
    Stop-TreeByPid ([int]$proc.Id)
  } catch {
    # ignore
  }
}

function Clear-ListenPort([int]$ListenPort) {
  $ownerIds = @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($ownerId in $ownerIds) {
    if ($ownerId -and $ownerId -ne 0) {
      Write-Info "Freeing port $ListenPort (PID $ownerId)..."
      Stop-TreeByPid ([int]$ownerId)
    }
  }
}

function Get-ProcessTreeMemoryMb([int]$ProcessId, $snapshot = $null) {
  if ($ProcessId -le 0) { return -1 }
  if (-not $snapshot) { $snapshot = Get-Win32ProcessSnapshot }
  $childMap = Get-ChildPidMap $snapshot
  $ws = @{}
  foreach ($p in @($snapshot)) {
    if ($p) { $ws[[int]$p.ProcessId] = [int64]$p.WorkingSetSize }
  }
  $total = 0L
  $queue = New-Object System.Collections.Generic.Queue[int]
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $queue.Enqueue($ProcessId) | Out-Null
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    if (-not $seen.Add($current)) { continue }
    if ($ws.ContainsKey($current)) { $total += $ws[$current] }
    if ($childMap.ContainsKey($current)) {
      foreach ($cid in $childMap[$current]) { $queue.Enqueue([int]$cid) }
    }
  }
  if ($total -le 0) { return -1 }
  return [math]::Round($total / 1MB)
}

function Write-PidFile($apiProc, $workerProc, $webProc) {
  $pidPath = Join-Path $ProjectRoot "storage\intranet.pids.json"
  $payload = @{
    at = (Get-Date).ToString('o')
    mode = $(if ($useProd) { 'prod' } else { 'dev' })
    api = $(if ($apiProc) { $apiProc.Id } else { $null })
    worker = $(if ($workerProc) { $workerProc.Id } else { $null })
    web = $(if ($webProc) { $webProc.Id } else { $null })
    ports = @{ web = $port; api = $apiPort; opencode = $opencodePort }
  } | ConvertTo-Json -Depth 4
  Set-Content -LiteralPath $pidPath -Value $payload -Encoding UTF8
}

if (-not $LocalOnly) {
  Ensure-FirewallRule $port
  Ensure-FirewallRule $apiPort
}
$lanIps = if ($LocalOnly) { @() } else { @(Get-LanIPv4Addresses) }
$webHostname = if ($LocalOnly) { '127.0.0.1' } else { '::' }

$apiProc = $null
$workerProc = $null
$webProc = $null
$tsxCli = Join-Path $ProjectRoot "node_modules\tsx\dist\cli.mjs"
$nextCli = Join-Path $ProjectRoot "node_modules\next\dist\bin\next"
$nodeExe = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $tsxCli)) {
  throw "Missing tsx. Run npm install first."
}
if (-not (Test-Path -LiteralPath $nextCli)) {
  throw "Missing next. Run npm install first."
}

function Start-ApiProcess {
  Clear-ListenPort $apiPort
  $env:AI4ES_ROLE = 'api'
  $env:AI4ES_USE_JOB_QUEUE = '1'
  $env:API_PORT = "$apiPort"
  $apiOut = Join-Path $ProjectRoot "storage\api-server.out.log"
  $apiErr = Join-Path $ProjectRoot "storage\api-server.err.log"
  return Start-Process -FilePath $nodeExe `
    -ArgumentList @($tsxCli, "server/api/index.ts") `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $apiOut `
    -RedirectStandardError $apiErr `
    -PassThru -WindowStyle Hidden
}

function Start-WorkerProcess {
  $env:AI4ES_ROLE = 'worker'
  Remove-Item Env:AI4ES_USE_JOB_QUEUE -ErrorAction SilentlyContinue
  $env:AI4ES_USE_JOB_QUEUE = '0'
  $workerOut = Join-Path $ProjectRoot "storage\worker.out.log"
  $workerErr = Join-Path $ProjectRoot "storage\worker.err.log"
  return Start-Process -FilePath $nodeExe `
    -ArgumentList @($tsxCli, "server/worker/index.ts") `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $workerOut `
    -RedirectStandardError $workerErr `
    -PassThru -WindowStyle Hidden
}

function Start-WebProcess {
  Clear-ListenPort $port
  $env:AI4ES_SPLIT = '1'
  $env:AI4ES_API_URL = "http://127.0.0.1:$apiPort"
  Remove-Item Env:AI4ES_USE_JOB_QUEUE -ErrorAction SilentlyContinue
  Remove-Item Env:AI4ES_ROLE -ErrorAction SilentlyContinue
  # 限制堆上限：OOM 崩溃后由看门狗拉起，优于无限膨胀后卡死无响应
  if (-not $env:NODE_OPTIONS -or $env:NODE_OPTIONS -notmatch 'max-old-space-size') {
    $env:NODE_OPTIONS = (($env:NODE_OPTIONS, '--max-old-space-size=3072') | Where-Object { $_ }).Trim() -join ' '
  }
  $webOut = Join-Path $ProjectRoot "storage\web-server.out.log"
  $webErr = Join-Path $ProjectRoot "storage\web-server.err.log"
  $nextArgs = if ($useProd) {
    @($nextCli, 'start', "--hostname=$webHostname", '-p', "$port")
  } else {
    @($nextCli, 'dev', '--webpack', "--hostname=$webHostname", '-p', "$port")
  }
  return Start-Process -FilePath $nodeExe `
    -ArgumentList $nextArgs `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $webOut `
    -RedirectStandardError $webErr `
    -PassThru -WindowStyle Hidden
}

try {
  Write-Info "Starting API (:$apiPort)..."
  $apiProc = Start-ApiProcess
  $healthUrl = "http://127.0.0.1:$apiPort/api/health"
  if (-not (Wait-HttpOk $healthUrl 90)) {
    throw "API not ready: $healthUrl (see storage/api-server.err.log)"
  }
  Write-Info "API ready: $healthUrl"

  Write-Info "Starting Worker..."
  $workerProc = Start-WorkerProcess

  Write-Info "Starting Web (:$port) with health watchdog..."
  $webProc = Start-WebProcess
  $webUrl = "http://127.0.0.1:$port/healthz"
  if (-not (Wait-HttpOk $webUrl 120)) {
    throw "Web not ready: $webUrl (see storage/web-server.out.log / web-server.err.log)"
  }
  Write-PidFile $apiProc $workerProc $webProc

  Write-Host ""
  Write-Host "========================================" -ForegroundColor Green
  Write-Host "  AI4ES ready (split architecture)" -ForegroundColor Green
  Write-Host "  Web:        http://localhost:$port" -ForegroundColor Green
  Write-Host "  API:        http://localhost:$apiPort" -ForegroundColor Green
  Write-Host "  OpenCode:   http://localhost:$opencodePort" -ForegroundColor Green
  if ($lanIps.Count -gt 0) {
    foreach ($ip in $lanIps) {
      Write-Host "  LAN:        http://${ip}:$port" -ForegroundColor Yellow
    }
  } elseif ($LocalOnly) {
    Write-Host "  Access:     local computer only" -ForegroundColor Green
  } else {
    Write-Host "  LAN:        (no LAN IP detected)" -ForegroundColor Yellow
  }
  Write-Host "  Model:      $modelUrl" -ForegroundColor Green
  if ($useProd) {
    Write-Host "  Mode:       prod (next start)" -ForegroundColor Green
  } else {
    Write-Host "  Mode:       dev (next dev + watchdog)" -ForegroundColor Green
  }
  Write-Host "  Watchdog:   health + memory>${webMaxMemoryMb}MB auto-restart" -ForegroundColor DarkGray
  Write-Host "  Stop:       Ctrl+C (also stops API/Worker/Web)" -ForegroundColor DarkGray
  Write-Host "========================================" -ForegroundColor Green
  Write-Host ""

  $webFailStreak = 0
  $apiFailStreak = 0
  while ($true) {
    Start-Sleep -Seconds 12

    # API 守护：以 HTTP 健康为准；进程句柄丢失但端口仍健康时不杀不重启
    $apiHttpOk = Test-HttpOkRetry $healthUrl 5 3
    $apiProcAlive = Test-ProcessAlive $apiProc
    $apiListenPid = Get-ListenPid $apiPort
    if ($apiHttpOk) {
      $apiFailStreak = 0
      if (-not $apiProcAlive -and $apiListenPid -gt 0) {
        try { $apiProc = Get-Process -Id $apiListenPid -ErrorAction Stop } catch { }
      }
    } else {
      $apiFailStreak++
      if ($apiFailStreak -ge 2) {
        Write-Warning "API unhealthy (health fail x$apiFailStreak) — restarting..."
        Stop-ChildProcess $apiProc
        Clear-ListenPort $apiPort
        $apiProc = Start-ApiProcess
        if (-not (Wait-HttpOk $healthUrl 90)) {
          Write-Warning "API restart failed (see storage/api-server.err.log)"
        } else {
          Write-Info "API restarted OK"
          $apiFailStreak = 0
        }
      }
    }

    $procSnap = Get-Win32ProcessSnapshot

    # Worker 守护：仅当句柄退出且没有同名残留时再拉起，避免叠多个 worker
    $workerAlive = Test-ProcessAlive $workerProc
    if (-not $workerAlive) {
      $orphanWorker = @($procSnap) |
        Where-Object { $_.CommandLine -and ($_.CommandLine -match 'server[\\/]+worker[\\/]+index\.ts') } |
        Select-Object -First 1
      if ($orphanWorker) {
        try { $workerProc = Get-Process -Id ([int]$orphanWorker.ProcessId) -ErrorAction Stop } catch {
          Write-Warning "Worker exited — restarting..."
          $workerProc = Start-WorkerProcess
          Write-Info "Worker restarted (PID $($workerProc.Id))"
        }
      } else {
        Write-Warning "Worker exited — restarting..."
        $workerProc = Start-WorkerProcess
        Write-Info "Worker restarted (PID $($workerProc.Id))"
      }
    }

    # Web 守护：HTTP 连续失败才重启；编译期偶发超时不立刻杀进程
    $webAlive = Test-ProcessAlive $webProc
    $webHttpOk = Test-HttpOkRetry $webUrl 10 2
    $webListenPid = Get-ListenPid $port
    if ($webHttpOk -and -not $webAlive -and $webListenPid -gt 0) {
      try { $webProc = Get-Process -Id $webListenPid -ErrorAction Stop } catch { }
      $webAlive = Test-ProcessAlive $webProc
    }
    $webMem = if ($webAlive) { Get-ProcessTreeMemoryMb ([int]$webProc.Id) $procSnap } else { -1 }
    $webOverMem = ($webMem -ge $webMaxMemoryMb)

    if (-not $webHttpOk) {
      $webFailStreak++
    } else {
      $webFailStreak = 0
    }

    if ($webOverMem -or $webFailStreak -ge $webHealthFailLimit) {
      $reason = if ($webOverMem) { "memory ${webMem}MB >= ${webMaxMemoryMb}MB" } else { "health fail x$webFailStreak" }
      Write-Warning "Web unhealthy ($reason) — restarting..."
      Stop-ChildProcess $webProc
      Clear-ListenPort $port
      Start-Sleep -Seconds 1
      $webProc = Start-WebProcess
      if (Wait-HttpOk $webUrl 120) {
        Write-Info "Web restarted OK (PID $($webProc.Id))"
        $webFailStreak = 0
      } else {
        Write-Warning "Web restart failed (see storage/web-server.*.log)"
      }
    }

    Write-PidFile $apiProc $workerProc $webProc
  }
}
finally {
  Write-Info "Stopping Web / API / Worker..."
  Stop-ChildProcess $webProc
  Stop-ChildProcess $workerProc
  Stop-ChildProcess $apiProc
  Clear-ListenPort $port
  Clear-ListenPort $apiPort
  Remove-Item -LiteralPath (Join-Path $ProjectRoot "storage\intranet.pids.json") -Force -ErrorAction SilentlyContinue
  if ($script:HasIntranetMutex -and $script:IntranetMutex) {
    try { [void]$script:IntranetMutex.ReleaseMutex() } catch { }
    try { $script:IntranetMutex.Dispose() } catch { }
  }
  Write-Info "Run npm run opencode:stop to stop OpenCode sidecar."
}
