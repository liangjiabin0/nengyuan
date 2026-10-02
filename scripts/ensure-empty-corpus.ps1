# Creates storage/knowledge-corpus/MANIFEST.md when a fresh clone has no corpus.
# Does not overwrite an existing manifest. Real records still come from
# `npm run corpus:export` after PostgreSQL has data.

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Manifest = Join-Path $ProjectRoot 'storage\knowledge-corpus\MANIFEST.md'
if (Test-Path -LiteralPath $Manifest) { exit 0 }

$dir = Split-Path -Parent $Manifest
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exportedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
@(
  '---'
  'record_key: corpus-manifest'
  'kind: manifest'
  'format: knowledge-corpus-markdown'
  'version: 1'
  "exported_at: $exportedAt"
  'database_path: ""'
  'database_fingerprint: empty'
  'total_records: 0'
  '---'
  ''
  '# Knowledge Corpus Manifest'
  ''
  '空语料占位，只为让 OpenCode 能启动。导入资料并写入 PostgreSQL 后执行 `npm run corpus:export`，该命令会覆盖本文件。'
  ''
  '## Record Counts'
  ''
  '- **person:** 0'
  '- **mentor:** 0'
  '- **paper:** 0'
  '- **patent:** 0'
  '- **book:** 0'
  '- **project:** 0'
  '- **nkrd:** 0'
  '- **output:** 0'
  ''
) | Set-Content -LiteralPath $Manifest -Encoding utf8
Write-Host "[corpus] wrote empty manifest: $Manifest"
