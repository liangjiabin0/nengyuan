param(
  [string]$OutputDir = "",
  [switch]$SkipBuild,
  [switch]$Zip
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

function Write-Info([string]$Message) {
  Write-Host $Message -ForegroundColor Cyan
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "未找到 $Name。打包机需要 Node.js 20+ (x64)。"
  }
}

Assert-Command "node"
Assert-Command "npm"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $OutputDir) {
  $OutputDir = Join-Path $ProjectRoot "dist\能元-AI4ES-内网便携-$stamp"
}
$OutputDir = [IO.Path]::GetFullPath($OutputDir)

Write-Info "项目根: $ProjectRoot"
Write-Info "输出目录: $OutputDir"

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot "node_modules"))) {
  Write-Info "安装 npm 依赖…"
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
}

Write-Info "安装 / 确认 OpenCode 与 ripgrep…"
& npm run opencode:install
if ($LASTEXITCODE -ne 0) { throw "opencode:install 失败" }

$opencodeExe = Join-Path $ProjectRoot "tools\opencode\opencode.exe"
$ripgrepExe = Join-Path $ProjectRoot "tools\ripgrep\rg.exe"
if (-not (Test-Path -LiteralPath $opencodeExe) -or -not (Test-Path -LiteralPath $ripgrepExe)) {
  throw "二进制缺失，无法打包便携包。"
}

if (-not $SkipBuild) {
  Write-Info "构建 Next 生产包…"
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "build 失败，便携包将回退为 next dev 启动。"
  }
}

# Ensure portable defaults exist on the source tree (copied into the pack).
$dataDir = Join-Path $ProjectRoot "数据"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "storage") | Out-Null

$settingsPath = Join-Path $ProjectRoot "storage\settings.json"
$portableSettings = [ordered]@{
  baseUrl = "http://10.1.4.166:11435/v1"
  model = "qwen3.6:35b-a3b"
  apiKey = ""
  think = $false
  # Relative to project root so the pack still works after copy/rename.
  dataRootDir = "数据"
}
if (Test-Path -LiteralPath $settingsPath) {
  try {
    $existing = Get-Content -Raw -Encoding UTF8 $settingsPath | ConvertFrom-Json
    if ($existing.apiKey) { $portableSettings.apiKey = [string]$existing.apiKey }
    if ($existing.model) { $portableSettings.model = [string]$existing.model }
    if ($existing.baseUrl) { $portableSettings.baseUrl = [string]$existing.baseUrl }
    if ($null -ne $existing.think) { $portableSettings.think = [bool]$existing.think }
  } catch {
    Write-Warning "读取现有 settings.json 失败，使用内网默认。"
  }
}

$envLocal = @"
LLM_API_KEY=
LLM_BASE_URL=http://10.1.4.166:11435/v1
LLM_MODEL=qwen3.6:35b-a3b
LLM_THINK=0
SEMANTIC_SEARCH=0
DATABASE_PATH=storage/rag.sqlite
DATA_ROOT_DIR=数据
"@

$readmeText = @"
能元（AI4ES）— 内网便携包

要求
- Windows x64
- 已安装 Node.js 20+（x64），且 node / npm 在 PATH 中
- 能访问内网模型（默认 http://10.1.4.166:11435/v1）

启动（一条命令）
1. 进入本目录
2. 执行: npm run start:intranet
3. 本机打开 http://localhost:3000；同事用脚本打印的「局域网打开」地址（http://本机IP:3000）

停止
- 终端 Ctrl+C 结束网页服务
- 再执行: npm run opencode:stop

更换模型
- 设置页，或编辑 .env.local / storage/settings.json 后重新 start:intranet

说明
- 本包已含 node_modules、tools\opencode、tools\ripgrep 与语料，目标机无需访问 GitHub。
"@

if (Test-Path -LiteralPath $OutputDir) {
  Remove-Item -LiteralPath $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$excludeDirs = @(
  ".git",
  ".cursor",
  "dist",
  "tools\caj2pdf-venv",
  "storage\uploads",
  "storage\exports",
  "storage\ragpack",
  "reports"
)

# robocopy: /E copy subdirs, /XD exclude dirs, /XF exclude files, /NFL /NDL /NJH /NJS quieter
$xdArgs = @()
foreach ($dir in $excludeDirs) {
  $xdArgs += $dir
}

Write-Info "复制文件到便携目录（可能较久）…"
$robolog = Join-Path $env:TEMP "pack-intranet-$stamp.log"
$rcArgs = @(
  $ProjectRoot,
  $OutputDir,
  "/E",
  "/XD"
) + $xdArgs + @(
  "/XF",
  "*.log",
  ".env.local",
  "/NFL",
  "/NDL",
  "/NJH",
  "/NJS",
  "/NP",
  "/R:1",
  "/W:1"
)
& robocopy @rcArgs | Out-Null
# robocopy exit codes 0-7 are success-ish
if ($LASTEXITCODE -ge 8) {
  throw "robocopy 失败，退出码 $LASTEXITCODE。日志: $robolog"
}

# Drop runtime sidecar state that contains absolute paths from the pack machine.
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $OutputDir "storage\opencode-sidecar.json")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $OutputDir "storage\opencode-sidecar.out.log")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $OutputDir "storage\opencode-sidecar.err.log")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $OutputDir "storage\llm-gateway.out.log")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $OutputDir "storage\llm-gateway.err.log")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $OutputDir "storage\opencode-sessions.json")

$portableSettings | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $OutputDir "storage\settings.json")
$envLocal | Set-Content -Encoding UTF8 (Join-Path $OutputDir ".env.local")
$readmeText | Set-Content -Encoding UTF8 (Join-Path $OutputDir "使用说明.txt")
New-Item -ItemType Directory -Force -Path (Join-Path $OutputDir "数据") | Out-Null

# Verify critical bits
foreach ($rel in @(
  "package.json",
  "scripts\intranet-start.ps1",
  "tools\opencode\opencode.exe",
  "tools\ripgrep\rg.exe",
  "node_modules",
  "opencode.json",
  ".opencode\agents\knowledge-qa.md"
)) {
  $path = Join-Path $OutputDir $rel
  if (-not (Test-Path -LiteralPath $path)) {
    throw "便携包缺少关键文件: $rel"
  }
}

Write-Host ""
Write-Host "便携目录已生成: $OutputDir" -ForegroundColor Green
Write-Host "目标机用法: cd 到该目录后执行  npm run start:intranet" -ForegroundColor Green

if ($Zip) {
  $zipPath = "$OutputDir.zip"
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -Force $zipPath }
  Write-Info "压缩为 zip（体积很大，请耐心等待）…"
  Compress-Archive -Path $OutputDir -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host "Zip: $zipPath" -ForegroundColor Green
}
