# 用本机 PowerPoint 把 PPTX 每页导出成 PNG（最终渲染检查用）。
#   powershell -NoProfile -ExecutionPolicy Bypass -File render-pptx.ps1 -Pptx <file.pptx> -OutDir <dir> [-Width 1920]
# 只读打开、不保存原文件；结束后关闭演示文稿，若是本脚本启动的 PowerPoint 则一并退出。
param(
  [Parameter(Mandatory = $true)][string]$Pptx,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Width = 1920
)
$ErrorActionPreference = 'Stop'
$Pptx = (Resolve-Path -LiteralPath $Pptx).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

$alreadyRunning = @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$app = New-Object -ComObject PowerPoint.Application
try {
  # 参数：ReadOnly, Untitled, WithWindow(不显示窗口)
  $deck = $app.Presentations.Open($Pptx, -1, 0, 0)
  try {
    $ratio = $deck.PageSetup.SlideHeight / $deck.PageSetup.SlideWidth
    $height = [int]([math]::Round($Width * $ratio))
    $files = @()
    for ($i = 1; $i -le $deck.Slides.Count; $i++) {
      $file = Join-Path $OutDir ('slide-{0:D2}.png' -f $i)
      $deck.Slides.Item($i).Export($file, 'PNG', $Width, $height)
      $files += $file
    }
    [pscustomobject]@{ slides = $deck.Slides.Count; width = $Width; height = $height; files = $files } | ConvertTo-Json -Compress
  } finally {
    $deck.Close()
  }
} finally {
  if (-not $alreadyRunning) { $app.Quit() }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
}
