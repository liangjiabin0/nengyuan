"""Check native coordinate-chart formatting; rendering and source verification remain required."""
import argparse,json,zipfile,math
from pathlib import Path
from xml.etree import ElementTree as ET
NS={'c':'http://schemas.openxmlformats.org/drawingml/2006/chart','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
def attr(node,path,key='val'):
 x=node.find(path,NS);return None if x is None else x.get(key)
def color(node,path):return attr(node,path+'/a:solidFill/a:srgbClr')
def min_font(node):
 vals=[float(x.get('sz'))/100 for x in node.iter() if x.tag in ('{'+NS['a']+'}defRPr','{'+NS['a']+'}rPr') and x.get('sz')]
 return min(vals) if vals else None
def audit(path):
 errors=[];warnings=[];records=[]
 with zipfile.ZipFile(path) as z:
  for name in sorted(x for x in z.namelist() if '/charts/chart' in x and x.endswith('.xml')):
   root=ET.fromstring(z.read(name));axes=root.findall('.//c:catAx',NS)+root.findall('.//c:valAx',NS)
   if not axes:continue
   r={'chart':name,'axes':[]}
   for ax in axes:
    axis= ax.tag.rsplit('}',1)[-1];prefix=f'{name} {axis}'
    grid=ax.find('c:majorGridlines/c:spPr/a:ln',NS)
    if grid is None or attr(grid,'a:prstDash') not in ('dash','sysDash','lgDash'):errors.append(prefix+': missing dashed major gridlines')
    if grid is not None and color(grid,'.')!='A6A6A6':errors.append(prefix+': gridline color must be A6A6A6')
    if color(ax,'c:spPr/a:ln')!='595959':errors.append(prefix+': axis color must be 595959')
    font=min_font(ax.find('c:txPr',NS)) if ax.find('c:txPr',NS) is not None else None
    if font is None or font<10:errors.append(prefix+': tick font must be explicit and >=10pt')
    if attr(ax,'c:majorTickMark') not in ('out','in','cross'):errors.append(prefix+': visible major tick marks required')
    title=ax.find('c:title',NS)
    if title is None or min_font(title) is None or min_font(title)<11:errors.append(prefix+': explicit axis title font >=11pt required')
    a={'type':axis,'fontPt':font}
    if axis=='valAx':
     try:
      lo=float(attr(ax,'c:scaling/c:min'));hi=float(attr(ax,'c:scaling/c:max'));step=float(attr(ax,'c:majorUnit'))
      if hi<=lo or step<=0:raise ValueError()
      count=(hi-lo)/step+1;a.update(min=lo,max=hi,majorUnit=step,tickCount=count)
      if not 5<=count<=7:warnings.append(prefix+': review nonstandard major tick count')
     except (ValueError,TypeError):errors.append(prefix+': explicit valid min/max/major unit required')
    r['axes'].append(a)
   plot=root.find('.//c:plotArea/c:spPr',NS)
   if plot is None or color(plot,'.')!='FFFFFF':errors.append(name+': plot background must be white')
   if plot is None or color(plot,'a:ln')!='595959':errors.append(name+': plot border must be visible dark gray')
   legend=root.find('.//c:legend',NS)
   if legend is not None:
    if attr(legend,'c:overlay')!='0':errors.append(name+': legend must not overlay data')
    ft=min_font(legend.find('c:txPr',NS)) if legend.find('c:txPr',NS) is not None else None
    if ft is None or ft<10:errors.append(name+': legend font must be >=10pt')
   records.append(r)
 return dict(pptx=str(path),chartCount=len(records),charts=records,errors=errors,warnings=warnings,passed=not errors,boundary='OOXML style only; inspect every final slide in PowerPoint and verify all values against the source.')
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('pptx',type=Path);p.add_argument('--receipt',type=Path);a=p.parse_args();r=audit(a.pptx)
 if a.receipt:a.receipt.write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf-8')
 print(json.dumps(r,ensure_ascii=False,indent=2));raise SystemExit(0 if r['passed'] else 1)
