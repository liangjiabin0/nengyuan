#!/usr/bin/env python3
from __future__ import annotations
import argparse,csv,json,re,shutil,tempfile,zipfile
from pathlib import Path
ILLEGAL=re.compile(r'[<>:"/\\|?*\x00-\x1f]')
DOWNLOADED={"downloaded_publisher_oa","downloaded_preprint","downloaded_repository"}
UNAVAILABLE={"paywalled","no_public_pdf_found","download_failed","not_assessable"}
def safe(s,limit=170): return re.sub(r'\s+',' ',ILLEGAL.sub('_',str(s))).strip().rstrip('.')[:limit] or 'untitled'
def is_pdf(p):
    p=Path(p)
    return p.is_file() and p.stat().st_size>4 and p.open('rb').read(5)==b'%PDF-'
def is_pptx(p):
    p=Path(p)
    if not p.is_file() or p.suffix.lower()!='.pptx': return False
    try:
        with zipfile.ZipFile(p) as z:
            names=z.namelist()
            return '[Content_Types].xml' in names and 'ppt/presentation.xml' in names and sum(1 for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml'))==2
    except zipfile.BadZipFile:
        return False
def write_csv(p,rows):
    fields=['No.','Title','Authors','Year','Venue/Source','DOI','Landing URL','Access status','Reason not downloaded','Suggested access route','Checked date']
    with p.open('w',encoding='utf-8-sig',newline='') as f: w=csv.DictWriter(f,fieldnames=fields); w.writeheader(); w.writerows(rows)
def copy_literature(item,lit):
    rows=[]
    for i,w in enumerate((item.get('literature') or [])[:3],1):
        st=w.get('acquisition_status',''); lp=w.get('local_pdf_path','')
        if st in DOWNLOADED:
            p=Path(lp)
            if not is_pdf(p): raise ValueError(f'invalid PDF: {p}')
            shutil.copy2(p,lit/f"{i:02d}_{safe(w.get('title',''),145)}.pdf")
        elif st in UNAVAILABLE:
            rows.append({'No.':i,'Title':w.get('title',''),'Authors':w.get('authors',''),'Year':w.get('year',''),'Venue/Source':w.get('source',''),'DOI':w.get('doi',''),'Landing URL':w.get('landing_url') or w.get('url',''),'Access status':st,'Reason not downloaded':w.get('access_note',''),'Suggested access route':w.get('suggested_access_route',''),'Checked date':w.get('checked_date','')})
        else: raise ValueError(f"{item.get('paper_title','')}: literature item lacks acquisition outcome: {w.get('title','')}")
    if rows: write_csv(lit/'无法下载文献清单.csv',rows)
def copy_pptx(item,pptdir,title):
    ppt_paths=[]
    if item.get('pptx_path'): ppt_paths.append((Path(item['pptx_path']),f'{title}_Two-Slide_Review.pptx'))
    for pp in item.get('pptx_paths') or []:
        if isinstance(pp,dict):
            path=Path(pp['path']); name=pp.get('filename') or f"{title}_{safe(pp.get('label','Two-Slide'),40)}.pptx"
        else:
            path=Path(pp); name=path.name
        ppt_paths.append((path,name))
    if not ppt_paths: raise FileNotFoundError(f'{title}: missing required two-slide pptx_path')
    for path,name in ppt_paths:
        if not is_pptx(path): raise ValueError(f'{title}: PPTX must exist, be a valid pptx, and contain exactly two slides: {path}')
        shutil.copy2(path,pptdir/safe(name,180))
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--manifest',required=True,type=Path); ap.add_argument('--output',required=True,type=Path); a=ap.parse_args(); m=json.loads(a.manifest.read_text(encoding='utf-8-sig')); papers=m.get('papers',[])
    if not papers: raise ValueError('manifest.papers is empty')
    with tempfile.TemporaryDirectory(prefix='review-batch-') as td:
        root=Path(td); od=root/'原文'; rd=root/'审稿意见'; od.mkdir(); rd.mkdir()
        for item in papers:
            title=safe(item['paper_title']); src=Path(item['source_path']); lang=item.get('manuscript_language','zh-CN')
            if not src.is_file(): raise FileNotFoundError(src)
            shutil.copy2(src,od/f'{title}{src.suffix}')
            pr=rd/f'{title}审稿意见'; lit=pr/'Latest Relevant Literature'; pptdir=pr/'Two-Slide PPT'; lit.mkdir(parents=True); pptdir.mkdir(parents=True)
            if lang=='en':
                en=Path(item['review_path_en']); zh=Path(item['review_path_zh'])
                if not en.is_file() or not zh.is_file(): raise FileNotFoundError('English paper requires both review_path_en and review_path_zh')
                shutil.copy2(en,pr/f'{title}_Review_English.docx'); shutil.copy2(zh,pr/f'{title}审稿意见_中文.docx')
            else:
                zh=Path(item['review_path_zh'] if item.get('review_path_zh') else item['review_path'])
                if not zh.is_file(): raise FileNotFoundError(zh)
                shutil.copy2(zh,pr/f'{title}审稿意见.docx')
            copy_literature(item,lit)
            if item.get('ppt_required',True): copy_pptx(item,pptdir,title)
            for key in ('review_md_path','review_md_path_zh','review_md_path_en'):
                if item.get(key):
                    markdown=Path(item[key])
                    if not markdown.is_file() or markdown.suffix.lower()!='.md': raise FileNotFoundError(markdown)
                    shutil.copy2(markdown,pr/markdown.name)
        a.output.parent.mkdir(parents=True,exist_ok=True)
        with zipfile.ZipFile(a.output,'w',zipfile.ZIP_DEFLATED) as z:
            for base in (od,rd):
                z.writestr(base.name+'/', '')
                for p in sorted(base.rglob('*')):
                    arc=str(p.relative_to(root)).replace('\\','/')
                    if p.is_dir(): z.writestr(arc.rstrip('/')+'/', '')
                    else: z.write(p,arc)
    with zipfile.ZipFile(a.output) as z:
        if z.testzip(): raise RuntimeError('ZIP integrity failure')
        top={n.split('/',1)[0] for n in z.namelist() if n}
        if top!={'原文','审稿意见'}: raise RuntimeError(top)
        for n in z.namelist():
            if n.endswith('.pptx') and '/Two-Slide PPT/' not in n: raise RuntimeError(f'PPTX must be under Two-Slide PPT/: {n}')
    print(a.output)
if __name__=='__main__': main()
