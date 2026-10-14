param([string]$Suffix='')
$ErrorActionPreference='Stop'
$out=Join-Path $PSScriptRoot ('build\render'+$Suffix)
New-Item -ItemType Directory -Path $out -Force | Out-Null
$created=$false
try{$app=[Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')}
catch{$app=New-Object -ComObject PowerPoint.Application;$created=$true}
$p=$null
try {
 $file=Join-Path $PSScriptRoot ('output\配电网双向重过载_两页图形版'+$Suffix+'.pptx')
 $p=$app.Presentations.Open($file,-1,0,0)
 for($i=1;$i -le 2;$i++){$p.Slides.Item($i).Export((Join-Path $out ('slide'+$i+'.png')),'PNG',1672,941)}
}finally{
 if($null -ne $p){$p.Close()}
 if($created -and $app.Presentations.Count -eq 0){$app.Quit()}
}
