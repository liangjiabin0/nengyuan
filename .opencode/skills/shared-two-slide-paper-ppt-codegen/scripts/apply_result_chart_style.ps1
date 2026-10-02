param(
  [Parameter(Mandatory=$true)][string]$SourcePptx,
  [Parameter(Mandatory=$true)][string]$OutputPptx,
  [string]$WorkingCopy,
  [int[]]$SlideNumbers = @(2)
)

$ErrorActionPreference = 'Stop'
$sourceResolved = [System.IO.Path]::GetFullPath($SourcePptx)
$outputResolved = [System.IO.Path]::GetFullPath($OutputPptx)
if ([string]::IsNullOrWhiteSpace($WorkingCopy)) {
  $WorkingCopy = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($outputResolved), ([System.IO.Path]::GetFileNameWithoutExtension($outputResolved) + '-working-copy.pptx'))
}
$workingResolved = [System.IO.Path]::GetFullPath($WorkingCopy)
Copy-Item -LiteralPath $sourceResolved -Destination $workingResolved -Force

function Apply-ChartStyle {
  param([Parameter(Mandatory=$true)]$Chart)

  $axisColor = 5855577
  $gridColor = 10921638
  $white = 16777215
  $focusColor = 10504960
  $baselineColors = @(192, 3373568, 8079968)
  $baselineDashes = @(4, 5, 3)
  $baselineMarkers = @(2, 1, 3)

  $Chart.ChartArea.Format.Fill.Solid()
  $Chart.ChartArea.Format.Fill.ForeColor.RGB = $white
  $Chart.ChartArea.Format.Line.Visible = 0
  $Chart.PlotArea.Format.Fill.Solid()
  $Chart.PlotArea.Format.Fill.ForeColor.RGB = $white
  $Chart.PlotArea.Format.Line.Visible = -1
  $Chart.PlotArea.Format.Line.ForeColor.RGB = $axisColor
  $Chart.PlotArea.Format.Line.Weight = 1.125

  foreach ($axisType in @(1, 2)) {
    $axis = $Chart.Axes($axisType, 1)
    $axis.Format.Line.Visible = -1
    $axis.Format.Line.ForeColor.RGB = $axisColor
    $axis.Format.Line.Weight = 1.125
    $axis.HasMajorGridlines = -1
    $axis.MajorGridlines.Format.Line.Visible = -1
    $axis.MajorGridlines.Format.Line.ForeColor.RGB = $gridColor
    $axis.MajorGridlines.Format.Line.DashStyle = 4
    $axis.MajorGridlines.Format.Line.Weight = 0.825
    $axis.TickLabels.Font.Name = 'Microsoft YaHei'
    if ($axis.TickLabels.Font.Size -lt 10) { $axis.TickLabels.Font.Size = 10.5 }
    if ($axis.HasTitle) {
      $axis.AxisTitle.Font.Name = 'Microsoft YaHei'
      if ($axis.AxisTitle.Font.Size -lt 11) { $axis.AxisTitle.Font.Size = 11.25 }
    }
  }

  if ($Chart.HasLegend) {
    $Chart.Legend.Position = -4160
    $Chart.Legend.IncludeInLayout = -1
    $Chart.Legend.Font.Name = 'Microsoft YaHei'
    if ($Chart.Legend.Font.Size -lt 10) { $Chart.Legend.Font.Size = 10.5 }
  }

  $focusIndex = $Chart.SeriesCollection().Count
  for ($index = 1; $index -le $Chart.SeriesCollection().Count; $index++) {
    $series = $Chart.SeriesCollection($index)
    $seriesName = [string]$series.Name
    if ($seriesName -match 'Hieroformer|WPFormer|本文方法|Proposed') { $focusIndex = $index }
  }
  $baselineIndex = 0
  for ($index = 1; $index -le $Chart.SeriesCollection().Count; $index++) {
    $series = $Chart.SeriesCollection($index)
    $series.Format.Line.Visible = -1
    if ($index -eq $focusIndex) {
      $series.Format.Line.ForeColor.RGB = $focusColor
      $series.Format.Line.Weight = 2.4
      $series.Format.Line.DashStyle = 1
      $series.MarkerStyle = 8
      $series.MarkerSize = 8
      $series.MarkerBackgroundColor = $focusColor
      $series.MarkerForegroundColor = $focusColor
    }
    else {
      $slot = $baselineIndex % $baselineColors.Count
      $series.Format.Line.ForeColor.RGB = $baselineColors[$slot]
      $series.Format.Line.Weight = 1.8
      $series.Format.Line.DashStyle = $baselineDashes[$slot]
      $series.MarkerStyle = $baselineMarkers[$slot]
      $series.MarkerSize = 6
      $series.MarkerBackgroundColor = $baselineColors[$slot]
      $series.MarkerForegroundColor = $baselineColors[$slot]
      $baselineIndex++
    }
  }
}

$powerPoint = $null
$presentation = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerPoint.Presentations.Open($workingResolved, 0, 0, 0)
  foreach ($slideNumber in $SlideNumbers) {
    $slide = $presentation.Slides.Item($slideNumber)
    foreach ($shape in $slide.Shapes) {
      $hasChart = $false
      try { $hasChart = [bool]$shape.HasChart } catch {}
      if ($hasChart) { Apply-ChartStyle -Chart $shape.Chart }
    }
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
