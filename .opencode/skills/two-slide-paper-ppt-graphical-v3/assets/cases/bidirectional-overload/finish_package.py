from pathlib import Path
from copy import deepcopy
from lxml import etree as E
import zipfile,json,posixpath
R=Path(__file__).parent;B=R/'build';spec=json.loads((B/'spec.json').read_text(encoding='utf-8'))
def read(p):
 with zipfile.ZipFile(p) as z:return {n:z.read(n) for n in z.namelist()}
d=read(B/'draft.pptx');template=read(spec['meta']['templatePptx'])
NS={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','c':'http://schemas.openxmlformats.org/drawingml/2006/chart'}
def xml(v):return E.tostring(v,encoding='UTF-8',xml_declaration=True,standalone=True)
tmpl=E.fromstring(template['ppt/slides/slide1.xml']);chrome=[]
for sh in tmpl.find('p:cSld/p:spTree',NS):
 n=sh.find('.//p:cNvPr',NS)
 if n is not None and n.get('name') in {'title-rule','summary','conclusion'}:chrome.append(deepcopy(sh))
for i in [1,2]:
 root=E.fromstring(d[f'ppt/slides/slide{i}.xml']);tree=root.find('p:cSld/p:spTree',NS)
 for k,sh in enumerate(chrome):
  q=deepcopy(sh);q.find('.//p:cNvPr',NS).set('id',str(8000+k));tree.insert(2+k,q)
 d[f'ppt/slides/slide{i}.xml']=xml(root)
# Inherit actual theme/master/layout parts. Their relationships use the same
# existing master/layout part names; no image relationships occur in this template.
for n,data in template.items():
 if any(n.startswith(prefix) for prefix in ['ppt/slideMasters/','ppt/slideLayouts/','ppt/theme/']):
  if n.endswith('.rels'):
   rr=E.fromstring(data)
   assert all(not rel.get('Type','').endswith('/image') for rel in rr),'template master assets need explicit import'
  d[n]=data
# Copy missing content type entries for imported shared parts.
ct=E.fromstring(d['[Content_Types].xml']);known={e.get('PartName') for e in ct};ctsrc=E.fromstring(template['[Content_Types].xml'])
for e in ctsrc:
 part=e.get('PartName','').lstrip('/')
 if part in d and e.get('PartName') not in known and e.get('PartName'):
  ct.append(deepcopy(e));known.add(e.get('PartName'))
d['[Content_Types].xml']=xml(ct)
for n in ['ppt/slides/_rels/slide1.xml.rels','ppt/slides/_rels/slide2.xml.rels']:
 rr=E.fromstring(d[n])
 for rel in rr:
  if rel.get('Type','').endswith('/slideLayout'):rel.set('Target','../slideLayouts/slideLayout1.xml')
 d[n]=xml(rr)
for n in list(d):
 if '/charts/chart' in n and n.endswith('.xml'):
  c=E.fromstring(d[n])
  for ax in c.findall('.//c:catAx',NS)+c.findall('.//c:valAx',NS):
   tick=ax.find('c:majorTickMark',NS)
   if tick is None:
    tick=E.Element('{'+NS['c']+'}majorTickMark');i=next((i for i,v in enumerate(ax) if v.tag.split('}')[-1] in ['minorTickMark','tickLblPos','spPr','txPr','crossAx']),len(ax));ax.insert(i,tick)
   tick.set('val','out')
  d[n]=xml(c)
with zipfile.ZipFile(B/'candidate.pptx','w',zipfile.ZIP_DEFLATED) as z:
 for n,v in d.items():z.writestr(n,v)
print('Template shared parts and chrome preserved; chart tick marks explicit')
