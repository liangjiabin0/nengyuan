$ErrorActionPreference = 'Continue'
$projectRoot = Split-Path $PSScriptRoot -Parent
$nextDir = Join-Path $projectRoot '.next'
$restored = @{}
$srcPathPattern = [regex]'src/((?:app|components|lib)/.+)$'
$inlinePattern = [regex]'sourceMappingURL=data:application/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)'
$mapCount = 0
$inlineCount = 0

foreach ($mapFile in (Get-ChildItem -Path $nextDir -Filter '*.map' -Recurse -ErrorAction SilentlyContinue)) {
  try {
    $raw = [System.IO.File]::ReadAllText($mapFile.FullName)
    if ($raw -notmatch 'sourcesContent') { continue }
    $map = $raw | ConvertFrom-Json
    if (-not $map.sources -or -not $map.sourcesContent) { continue }
    for ($i = 0; $i -lt $map.sources.Count; $i++) {
      $source = [string]$map.sources[$i]
      $content = [string]$map.sourcesContent[$i]
      if ([string]::IsNullOrWhiteSpace($source) -or [string]::IsNullOrWhiteSpace($content)) { continue }
      if ($source -match 'node_modules|__nextjs-internal-proxy|webpack-internal') { continue }
      $match = $srcPathPattern.Match(($source -replace '\\', '/'))
      if (-not $match.Success) { continue }
      if ($content -match '^export default "[0-9a-f]+"$') { continue }
      $rel = $match.Groups[1].Value
      $target = Join-Path $projectRoot ('src\' + ($rel -replace '/', '\'))
      if ($rel -match '\.\.') { continue }
      if (-not $restored.ContainsKey($target) -or $content.Length -gt $restored[$target].Length) {
        $restored[$target] = $content
      }
    }
    $mapCount++
  } catch { }
}

foreach ($jsFile in (Get-ChildItem -Path $nextDir -Filter '*.js' -Recurse -ErrorAction SilentlyContinue)) {
  try {
    if ($jsFile.PSIsContainer) { continue }
    $raw = [System.IO.File]::ReadAllText($jsFile.FullName)
    foreach ($match in $inlinePattern.Matches($raw)) {
      $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($match.Groups[1].Value))
      if ($json -notmatch 'sourcesContent') { continue }
      $map = $json | ConvertFrom-Json
      if (-not $map.sources -or -not $map.sourcesContent) { continue }
      for ($i = 0; $i -lt $map.sources.Count; $i++) {
        $source = [string]$map.sources[$i]
        $content = [string]$map.sourcesContent[$i]
        if ([string]::IsNullOrWhiteSpace($source) -or [string]::IsNullOrWhiteSpace($content)) { continue }
        if ($source -match 'node_modules|__nextjs-internal-proxy|webpack-internal') { continue }
        $pathMatch = $srcPathPattern.Match(($source -replace '\\', '/'))
        if (-not $pathMatch.Success) { continue }
        if ($content -match '^export default "[0-9a-f]+"$') { continue }
        $rel = $pathMatch.Groups[1].Value
        $target = Join-Path $projectRoot ('src\' + ($rel -replace '/', '\'))
        if ($rel -match '\.\.') { continue }
        if (-not $restored.ContainsKey($target) -or $content.Length -gt $restored[$target].Length) {
          $restored[$target] = $content
        }
      }
      $inlineCount++
    }
  } catch { }
}

Write-Output "Collected $($restored.Count) unique source files."
$count = 0
foreach ($target in @($restored.Keys)) {
  $dir = Split-Path $target -Parent
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  [System.IO.File]::WriteAllText($target, $restored[$target], [System.Text.UTF8Encoding]::new($false))
  $count++
}

Write-Output "Restored $count source files."
Write-Output "  from .map files: $mapCount"
Write-Output "  from inline maps: $inlineCount"
Get-ChildItem -Path (Join-Path $projectRoot 'src') -Recurse -File -ErrorAction SilentlyContinue |
  Group-Object Extension | Sort-Object Name | ForEach-Object {
    Write-Output ("  {0}: {1}" -f $_.Name, $_.Count)
  }
