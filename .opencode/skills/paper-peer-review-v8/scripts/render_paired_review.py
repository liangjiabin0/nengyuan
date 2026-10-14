from pathlib import Path
import argparse,json,re,zipfile
from copy import deepcopy
from lxml import etree
from docx import Document
from docx.shared import Pt,Cm,RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
MML='http://www.w3.org/1998/Math/MathML'
TRANS=None
def element(tag,text=None,*kids):
    e=etree.Element('{'+MML+'}'+tag)
    if text is not None:e.text=text
    e.extend(kids);return e
COMMANDS={'Delta':'Δ','Sigma':'Σ','alpha':'α','beta':'β','lambda':'λ','phi':'φ','rho':'ρ','Phi':'Φ','infty':'∞','top':'⊤','leq':'≤','quad':' ','sum':'∑','min':'min','max':'max'}
def mathml(source):
    tokens=re.findall(r'\\[A-Za-z]+|\\.|[{}_^]|[A-Za-z]+|\d+(?:\.\d+)?|[^\s]',source);pos=0
    def atom():
        nonlocal pos
        t=tokens[pos];pos+=1
        if t=='{':return parse('}')
        if t=='\\frac':return element('mfrac',None,atom(),atom())
        if t.startswith('\\'):
            value=COMMANDS.get(t[1:],t[1:] if len(t)>2 else t[1:])
            return element('mi' if value.isalpha() else 'mo',value)
        return element('mn' if t[0].isdigit() else 'mi' if t.isalpha() else 'mo',t)
    def parse(end=None):
        nonlocal pos
        nodes=[]
        while pos<len(tokens) and tokens[pos]!=end:
            a=atom();sub=sup=None
            while pos<len(tokens) and tokens[pos] in ['_','^']:
                key=tokens[pos];pos+=1;v=atom()
                if key=='_':sub=v
                else:sup=v
            if sub is not None and sup is not None:a=element('msubsup',None,a,sub,sup)
            elif sub is not None:a=element('msub',None,a,sub)
            elif sup is not None:a=element('msup',None,a,sup)
            nodes.append(a)
        if end is not None:
            assert pos<len(tokens) and tokens[pos]==end;pos+=1
        return element('mrow',None,*nodes)
    e=element('math',None,parse());assert pos==len(tokens);return e

def font(run,size=10.5,bold=False,east='宋体'):
    run.font.name='Times New Roman';run.font.size=Pt(size);run.font.bold=bold;run.font.color.rgb=RGBColor(0,0,0)
    run._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),east)
INLINE=re.compile(r'(ΔEUE|EUE|Ω|N|F|C|α|β|φ|ρ|R|D|p|m)(?=[_^])(?:_([a-zA-Z∞]+))?(?:\^([a-zA-Z0-9]+))?')
def normalized(s):return INLINE.sub(lambda m:m[1]+(m[2] or '')+(m[3] or ''),s)
def inline(para,s):
    at=0
    for m in INLINE.finditer(s):
        font(para.add_run(s[at:m.start()]));font(para.add_run(m[1]))
        if m[2]:r=para.add_run(m[2]);font(r);r.font.subscript=True
        if m[3]:r=para.add_run(m[3]);font(r);r.font.superscript=True
        at=m.end()
    font(para.add_run(s[at:]))
def text(doc,s,style=None):
    para=doc.add_paragraph(style=style);inline(para,s);return para
def tbl(doc,headers,rows):
    t=doc.add_table(rows=1,cols=len(headers));t.autofit=False
    # Preserve the supplied reports' concise hierarchy, with black headings and gray borders.
    widths=([3.,13.5] if len(headers)==2 else [2.9,4.6,9.] if len(headers)==3 else [3.8,2.5,5.6,4.7] if len(headers)==4 else [4.5,2.5,4.7,2.4,2.5])
    for cell,w in zip(t.rows[0].cells,widths):cell.width=Cm(w)
    for cell,s in zip(t.rows[0].cells,headers):cell.text='';inline(cell.paragraphs[0],str(s))
    repeat=OxmlElement('w:tblHeader');t.rows[0]._tr.get_or_add_trPr().append(repeat)
    for row in rows:
        cells=t.add_row().cells
        for cell,w,s in zip(cells,widths,row):cell.width=Cm(w);cell.text='';inline(cell.paragraphs[0],str(s))
    borders=OxmlElement('w:tblBorders')
    for side in ['top','left','bottom','right','insideH','insideV']:
        e=OxmlElement('w:'+side);e.set(qn('w:val'),'single');e.set(qn('w:sz'),'4');e.set(qn('w:color'),'D9D9D9');borders.append(e)
    t._tbl.tblPr.append(borders)
    for ri,row in enumerate(t.rows):
        no=OxmlElement('w:cantSplit');row._tr.get_or_add_trPr().append(no)
        for cell in row.cells:
            cell.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
            for para in cell.paragraphs:
                para.paragraph_format.space_after=Pt(3);para.paragraph_format.space_before=Pt(3);para.paragraph_format.line_spacing=1.05
                if ri==0 or (len(rows)<=4 and ri<len(rows)):para.paragraph_format.keep_with_next=True
                for run in para.runs:font(run,9 if len(headers)>3 else 9.5,ri==0)
            if ri==0:
                shade=OxmlElement('w:shd');shade.set(qn('w:fill'),'F2F2F2');cell._tc.get_or_add_tcPr().append(shade)
    doc.add_paragraph().paragraph_format.space_after=Pt(0)

def create(d,output_dir):
    title=d['metadata']['paper_title'];folder=Path(output_dir);folder.mkdir(parents=True,exist_ok=True)
    doc=Document();sec=doc.sections[0];sec.page_width=Cm(21);sec.page_height=Cm(29.7)
    sec.top_margin=Cm(1.8);sec.bottom_margin=Cm(1.7);sec.left_margin=Cm(2.2);sec.right_margin=Cm(2.2)
    for name,size in [('Normal',10.5),('Title',18),('Heading 1',14),('Heading 2',11.5)]:
        st=doc.styles[name];st.font.name='Times New Roman';st.font.size=Pt(size);st.font.color.rgb=RGBColor(0,0,0)
        st._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),'宋体' if name=='Normal' else '黑体')
        st.paragraph_format.space_after=Pt(4);st.paragraph_format.line_spacing=1.08
        if name!='Normal':st.font.bold=True;st.paragraph_format.space_before=Pt(10);st.paragraph_format.keep_with_next=True
        ppr=st._element.get_or_add_pPr()
        for border in ppr.findall(qn('w:pBdr')):ppr.remove(border)
    doc.core_properties.title=title+'审稿意见';doc.core_properties.author='';doc.core_properties.subject='人工补强要求下的重新评审'
    md=[];expected=[];ne=0;nt=0
    for b in d['report_blocks']:
        kind=b['type']
        if kind=='heading':
            if b['level']==0:
                para=doc.add_paragraph(b['text'],style='Title');para.alignment=WD_ALIGN_PARAGRAPH.CENTER
            else:doc.add_heading(b['text'],level=b['level'])
            expected.append(('text',b['text']));md+=['#'*(max(1,b['level']+1))+' '+b['text'],'']
        elif kind=='paragraph':
            para=text(doc,b['text']);expected.append(('text',normalized(b['text'])));md +=[b['text'],'']
            if b['text']==title:
                para.alignment=WD_ALIGN_PARAGRAPH.CENTER
                for run in para.runs:font(run,12,True,'黑体')
        elif kind=='table':
            tbl(doc,b['headers'],b['rows']);nt+=1
            flat=[normalized(str(v)) for row in [b['headers']]+b['rows'] for v in row];expected.append(('table',flat))
            esc=lambda s:str(s).replace('|',r'\|').replace('\n','<br>')
            md+=['| '+' | '.join(map(esc,b['headers']))+' |','| '+' | '.join(['---']*len(b['headers']))+' |']
            md.extend('| '+' | '.join(map(esc,row))+' |' for row in b['rows']);md.append('')
        elif kind=='equation':
            para=text(doc,b['label']);para.paragraph_format.keep_with_next=True
            expected.append(('text',b['label']))
            para=doc.add_paragraph();para.alignment=WD_ALIGN_PARAGRAPH.CENTER
            native=TRANS(mathml(b['latex'])).getroot();para._p.append(deepcopy(native));ne+=1;expected.append(('equation',b['latex']))
            md +=[b['label'],'','$$',b['latex'],'$$','']
    footer=sec.footer.paragraphs[0];footer.alignment=WD_ALIGN_PARAGRAPH.CENTER
    fld=OxmlElement('w:fldSimple');fld.set(qn('w:instr'),'PAGE');footer._p.append(fld)
    dest=folder/(title+'审稿意见.docx');doc.save(dest)
    (folder/(title+'审稿意见.md')).write_text('\n'.join(md),encoding='utf-8')
    # Read saved OOXML back; compare all paragraphs/tables to the one canonical record.
    with zipfile.ZipFile(dest) as z:
        xml=etree.fromstring(z.read('word/document.xml'))
        ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','m':'http://schemas.openxmlformats.org/officeDocument/2006/math'}
        actual=[]
        for child in xml.find('w:body',ns):
            if child.tag==qn('w:p'):
                if child.xpath('.//m:oMath',namespaces=ns):actual.append(('equation',None))
                else:
                    s=''.join(child.xpath('.//w:t/text()',namespaces=ns))
                    if s:actual.append(('text',s))
            elif child.tag==qn('w:tbl'):
                actual.append(('table',[''.join(c.xpath('.//w:t/text()',namespaces=ns)) for c in child.xpath('./w:tr/w:tc',namespaces=ns)]))
        assert len(actual)==len(expected),(len(actual),len(expected))
        for a,e in zip(actual,expected):assert a[0]==e[0] and (a[0]=='equation' or a[1]==e[1]),(a,e)
        assert len(xml.xpath('//m:oMath',namespaces=ns))==ne
    (folder/'pair_validation.json').write_text(json.dumps(dict(equal=True,blocks=len(expected),native_equations=ne,tables=nt,formula_source=[b['latex'] for b in d['report_blocks'] if b['type']=='equation']),ensure_ascii=False,indent=2),encoding='utf-8')

def main():
    global TRANS
    ap=argparse.ArgumentParser(description='Render matched MD/DOCX from report_blocks; native equations and structural parity.')
    ap.add_argument('record',type=Path);ap.add_argument('--output-dir',required=True,type=Path)
    ap.add_argument('--mathml-xsl',type=Path,default=Path(r'C:\Program Files\Microsoft Office\root\Office16\MML2OMML.XSL'))
    a=ap.parse_args();d=json.loads(a.record.read_text(encoding='utf-8-sig'))
    if any(b['type']=='equation' for b in d['report_blocks']):
        if not a.mathml_xsl.is_file():raise SystemExit('Native equation conversion requires --mathml-xsl; preserve Markdown and resolve the converter before DOCX delivery.')
        TRANS=etree.XSLT(etree.parse(str(a.mathml_xsl)))
    create(d,a.output_dir)
if __name__=='__main__':main()
