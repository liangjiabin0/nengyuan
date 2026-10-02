param()

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $ProjectRoot

function Write-Info([string]$Message) {
  Write-Host $Message -ForegroundColor Cyan
}

$listening = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port 5432 -WarningAction SilentlyContinue
  if (-not $probe.TcpTestSucceeded) {
    throw @"
PostgreSQL 未在 127.0.0.1:5432 监听。
请先安装 PostgreSQL 16（winget install PostgreSQL.PostgreSQL.16），创建角色和数据库：

  CREATE ROLE ai4es LOGIN PASSWORD '<强密码>';
  CREATE DATABASE ai4es OWNER ai4es;

然后在 .env.local 设置：
  DATABASE_URL=postgres://ai4es:<url-encoded-password>@127.0.0.1:5432/ai4es
"@
  }
}

Write-Info "PostgreSQL port 5432 is open, checking DATABASE_URL..."
& npx --yes tsx scripts/check-postgres.ts
if ($LASTEXITCODE -ne 0) {
  throw "PostgreSQL is listening but DATABASE_URL login failed. Check .env.local."
}
