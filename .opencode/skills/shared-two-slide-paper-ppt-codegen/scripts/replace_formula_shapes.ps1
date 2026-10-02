param(
  [Parameter(Mandatory=$true)][string]$SourcePptx,
  [Parameter(Mandatory=$true)][string]$OutputPptx,
  [Parameter(Mandatory=$true)][string]$ManifestJson
)

$ErrorActionPreference = 'Stop'
$sourceResolved = [System.IO.Path]::GetFullPath($SourcePptx)
$outputResolved = [System.IO.Path]::GetFullPath($OutputPptx)
$manifestResolved = [System.IO.Path]::GetFullPath($ManifestJson)
$config = Get-Content -LiteralPath $manifestResolved -Raw -Encoding UTF8 | ConvertFrom-Json
$powerPoint = $null
$presentation = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerPoint.Presentations.Open($sourceResolved, 0, 0, 0)
  foreach ($formula in $config.formulas) {
    $slide = $presentation.Slides.Item([int]$formula.slide)
    $target = $null
    foreach ($shape in $slide.Shapes) {
      if ($shape.Name -eq [string]$formula.targetShapeName) { $target = $shape; break }
    }
    if ($null -eq $target) { throw "Formula shape not found: $($formula.targetShapeName)" }
    $target.Delete()
    $position = $formula.placedPosition
    $picture = $slide.Shapes.AddPicture(
      [System.IO.Path]::GetFullPath([string]$formula.svgPath), 0, -1,
      [single]([double]$position.left * 0.75), [single]([double]$position.top * 0.75),
      [single]([double]$position.width * 0.75), [single]([double]$position.height * 0.75)
    )
    $picture.Name = "latex-svg-$($formula.id)"
    $picture.AlternativeText = "LaTeX: $($formula.latex)"
  }
  $presentation.SaveAs($outputResolved, 24)
  $presentation.Close(); $presentation = $null
  $powerPoint.Quit(); $powerPoint = $null
  Write-Output $outputResolved
}
finally {
  if ($null -ne $presentation) { try { $presentation.Close() } catch {} }
  if ($null -ne $powerPoint) { try { $powerPoint.Quit() } catch {} }
  if ($null -ne $presentation) { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) }
  if ($null -ne $powerPoint) { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint) }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
