param(
  [ValidateSet('prod', 'dev')]
  [string]$Mode = 'prod',
  [switch]$SkipGitPull,
  [switch]$SkipPython,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot
. (Join-Path $PSScriptRoot 'project-env.ps1')
Import-Ai4esProjectEnv $ProjectRoot

function Invoke-Step([string]$Label, [scriptblock]$Action) {
  Write-Host "[deploy] $Label" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "Deployment step failed: $Label" }
}

if (-not $SkipGitPull -and (Test-Path -LiteralPath (Join-Path $ProjectRoot '.git'))) {
  Invoke-Step 'git pull --ff-only' { git pull --ff-only }
}

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot '.env.local'))) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot '.env.example') -Destination (Join-Path $ProjectRoot '.env.local')
  throw 'Created .env.local from .env.example. Fill DATABASE_URL, DEFAULT_ADMIN_PASSWORD and required API keys, then rerun deployment.'
}

Invoke-Step 'locked Node.js install' { npm ci }
Invoke-Step 'project-local runtime install' {
  $runtimeArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot 'install-portable-runtime.ps1'),
    '-SkipNpm'
  )
  if ($SkipPython) { $runtimeArgs += '-SkipPython' }
  & powershell @runtimeArgs
}
Invoke-Step 'PostgreSQL health check' {
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'ensure-postgres.ps1')
}

if ($Mode -eq 'prod') {
  Invoke-Step 'Next.js production build' { npm run build }
}
Invoke-Step 'portability audit' { npm run portable:audit }

if ($NoStart) {
  Write-Host '[deploy] verified; start was skipped.' -ForegroundColor Green
  return
}

$startScript = if ($Mode -eq 'prod') { 'start:intranet:prod' } else { 'start:intranet' }
Write-Host "[deploy] starting $startScript (keep this process under your server supervisor)." -ForegroundColor Green
& npm run $startScript
