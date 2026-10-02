param(
  [switch]$DryRun,
  [switch]$SoftwareOnly
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Rclone = Join-Path $env:LOCALAPPDATA 'rclone\rclone.exe'
$Filter = Join-Path $PSScriptRoot 'sync-to-intranet.exclude'
$LongNameFilter = Join-Path $PSScriptRoot 'sync-to-intranet-longnames.exclude'
$SoftwareFilter = Join-Path $PSScriptRoot 'sync-to-intranet-software.include'
$Log = Join-Path $env:TEMP $(if ($SoftwareOnly) { 'ai4es-rclone-software.log' } else { 'ai4es-rclone-sync.log' })
$Config = Join-Path $env:APPDATA 'rclone\rclone.conf'

if (-not (Test-Path -LiteralPath $Rclone)) {
  throw "rclone not found: $Rclone"
}
if (-not (Test-Path -LiteralPath $Filter)) {
  throw "exclude list not found: $Filter"
}
if (-not (Test-Path -LiteralPath $Config)) {
  throw "rclone config not found: $Config"
}

# Do not send intranet SSH/SFTP through FlClash (127.0.0.1:7890).
$bypass = 'localhost,127.0.0.1,::1,10.1.4.166,10.0.0.0/8,10.*,*.local'
foreach ($name in @(
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy'
  )) {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
$env:NO_PROXY = $bypass
$env:no_proxy = $bypass

$lanIp = (
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -like '10.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1 -ExpandProperty IPAddress
)

$src = $ProjectRoot
if (-not $src.EndsWith('\') -and -not $src.EndsWith('/')) {
  $src = $src + '\'
}

# copy never deletes destination files.
# --update skips destination files whose mtime is newer than local
# (typical case: conversations created or edited on the server).
$common = @(
  '--update',
  '--create-empty-src-dirs',
  '--transfers', $(if ($SoftwareOnly) { '16' } else { '4' }),
  '--checkers', $(if ($SoftwareOnly) { '16' } else { '8' }),
  '--sftp-concurrency', $(if ($SoftwareOnly) { '16' } else { '8' }),
  '--retries', '3',
  '--low-level-retries', '10',
  '--retries-sleep', '10s',
  '--timeout', '30m',
  '--contimeout', '60s',
  '--modify-window', '2s',
  '--fast-list',
  '--stats', '30s',
  '--stats-one-line',
  '--stats-log-level', 'NOTICE',
  '--log-file', $Log,
  '--log-level', 'INFO'
)
if ($lanIp) {
  $common += @('--bind', $lanIp)
  Write-Host "bind: $lanIp (direct LAN, no proxy)"
}
if ($DryRun) { $common += '--dry-run' }

Write-Host "mode: copy --update (upload local new/changed; skip dest-newer; never delete dest)"
Write-Host "log: $Log"

if ($SoftwareOnly) {
  $dirs = @(
    'src', 'server', 'scripts', 'public', 'docs', 'eval', 'examples', 'vendor', '.opencode', 'tools'
  )
  $rootFiles = @(
    'package.json', 'package-lock.json', 'next.config.js', 'next-env.d.ts',
    'tsconfig.json', 'tailwind.config.ts', 'postcss.config.js', 'eslint.config.mjs',
    'ecosystem.config.cjs', 'opencode.json', 'AGENTS.md', 'CLAUDE.md',
    'README.md', 'DEPLOY.md', 'SYSTEM_DEPENDENCIES.md', '.gitignore', '.env.example'
  )
  foreach ($dir in $dirs) {
    $localDir = Join-Path $ProjectRoot $dir
    if (-not (Test-Path -LiteralPath $localDir)) { continue }
    Write-Host "copy $dir"
    $dirArgs = @('copy', $localDir, "ai4es:/data/ai4es/$dir") + $common
    if ($dir -eq 'tools') {
      $dirArgs += @(
        '--exclude', '*-venv/**',
        '--exclude', 'opencode/**',
        '--exclude', 'ripgrep/**',
        '--exclude', 'libreoffice/**',
        '--exclude', '*.dll',
        '--exclude', '*.exe'
      )
    }
    if ($dir -eq '.opencode') {
      $dirArgs += @(
        '--exclude', 'node_modules/**',
        # These four SKILL.md files contain OS-specific office-docs-venv Python paths.
        # Keep the server's Linux variants instead of replacing them with Windows paths.
        '--exclude', 'skills/docx/SKILL.md',
        '--exclude', 'skills/pdf/SKILL.md',
        '--exclude', 'skills/pptx/SKILL.md',
        '--exclude', 'skills/xlsx/SKILL.md'
      )
    }
    & $Rclone @dirArgs
    if ($LASTEXITCODE -ne 0) { throw "rclone exited $LASTEXITCODE while copying $dir" }
  }
  foreach ($file in $rootFiles) {
    $localFile = Join-Path $ProjectRoot $file
    if (-not (Test-Path -LiteralPath $localFile)) { continue }
    Write-Host "copy $file"
    $fileArgs = @('copy', $localFile, 'ai4es:/data/ai4es') + $common
    & $Rclone @fileArgs
    if ($LASTEXITCODE -ne 0) { throw "rclone exited $LASTEXITCODE while copying $file" }
  }
  $settingsFile = Join-Path $ProjectRoot 'storage\settings.json'
  if (Test-Path -LiteralPath $settingsFile) {
    Write-Host 'copy storage/settings.json'
    $settingsArgs = @('copy', $settingsFile, 'ai4es:/data/ai4es/storage') + $common
    & $Rclone @settingsArgs
    if ($LASTEXITCODE -ne 0) { throw "rclone exited $LASTEXITCODE while copying storage/settings.json" }
  }
} else {
  $copyArgs = @(
    'copy', $src, 'ai4es:/data/ai4es',
    '--exclude-from', $Filter
  )
  if (Test-Path -LiteralPath $LongNameFilter) {
    $copyArgs += @('--exclude-from', $LongNameFilter)
  }
  $copyArgs += @('--ignore-errors') + $common
  & $Rclone @copyArgs
  if ($LASTEXITCODE -ne 0) { throw "rclone exited $LASTEXITCODE" }
}
