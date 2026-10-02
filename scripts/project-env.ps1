function Import-Ai4esProjectEnv([string]$ProjectRoot) {
  foreach ($name in @('.env', '.env.local')) {
    $file = Join-Path $ProjectRoot $name
    if (-not (Test-Path -LiteralPath $file)) { continue }
    foreach ($line in Get-Content -LiteralPath $file -Encoding UTF8) {
      $trimmed = $line.Trim()
      if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
      $equals = $trimmed.IndexOf('=')
      if ($equals -le 0) { continue }
      $key = $trimmed.Substring(0, $equals).Trim()
      if (-not $key -or (Test-Path "Env:$key")) { continue }
      $value = $trimmed.Substring($equals + 1).Trim()
      if ($value.Length -ge 2 -and (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
      )) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      Set-Item -Path "Env:$key" -Value $value
    }
  }
  $env:AI4ES_PROJECT_ROOT = [IO.Path]::GetFullPath($ProjectRoot)
  $pathPrefix = @()
  foreach ($exeName in @('mutool.exe', 'pdftoppm.exe')) {
    $rootName = if ($exeName -eq 'mutool.exe') { 'mupdf' } else { 'poppler' }
    $hit = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "tools\$rootName") -Recurse -Filter $exeName -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { $pathPrefix += $hit.DirectoryName }
  }
  if ($pathPrefix.Count -gt 0) {
    $env:PATH = (($pathPrefix | Select-Object -Unique) -join ';') + ';' + $env:PATH
  }

  # Child processes must emit UTF-8, not the console code page. On a Chinese
  # Windows box cp936 output reaches the agent as mojibake, so it cannot read
  # its own error messages or any path containing Chinese characters.
  if (-not $env:PYTHONUTF8) { $env:PYTHONUTF8 = '1' }
  if (-not $env:PYTHONIOENCODING) { $env:PYTHONIOENCODING = 'utf-8' }
  try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $global:OutputEncoding = [Console]::OutputEncoding
  } catch {
    # a redirected or closed console has no encoding to set
  }
}
