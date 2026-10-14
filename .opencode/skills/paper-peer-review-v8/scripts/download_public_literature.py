#!/usr/bin/env python3
from __future__ import annotations
import argparse, datetime as dt, json, re, shutil, urllib.request, urllib.error
from pathlib import Path

DOWNLOADED={"downloaded_publisher_oa","downloaded_preprint","downloaded_repository"}
UNAVAILABLE={"paywalled","no_public_pdf_found","download_failed","not_assessable"}
ILLEGAL=re.compile(r'[<>:"/\\|?*\x00-\x1f]')

def safe(s): return re.sub(r'\s+',' ',ILLEGAL.sub('_',str(s))).strip().rstrip('.')[:145] or 'literature'
def is_pdf(p):
    return p.is_file() and p.stat().st_size>4 and p.open('rb').read(5)==b'%PDF-'
def status_for(v): return 'downloaded_publisher_oa' if v=='publisher' else ('downloaded_preprint' if v=='preprint' else 'downloaded_repository')
def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--review-json',required=True,type=Path); ap.add_argument('--output-dir',required=True,type=Path); ap.add_argument('--manifest-out',required=True,type=Path); ap.add_argument('--timeout',type=int,default=30); a=ap.parse_args()
    d=json.loads(a.review_json.read_text(encoding='utf-8-sig')); works=d.get('latest_literature_comparison',{}).get('recent_relevant_works',[])[:3]; a.output_dir.mkdir(parents=True,exist_ok=True); out=[]
    for i,w0 in enumerate(works,1):
        w=dict(w0); dest=a.output_dir/f"{i:02d}_{safe(w.get('title',''))}.pdf"; ok=False; notes=[]
        lp=w.get('local_pdf_path')
        if lp and is_pdf(Path(lp)):
            shutil.copy2(lp,dest); ok=True
        else:
            urls=[]
            if w.get('pdf_url'): urls.append(w['pdf_url'])
            urls += [u for u in (w.get('pdf_urls') or []) if u]
            for url in urls:
                try:
                    req=urllib.request.Request(url,headers={'User-Agent':'paper-peer-review/5.0','Accept':'application/pdf,*/*;q=0.1'})
                    tmp=dest.with_suffix('.pdf.part')
                    with urllib.request.urlopen(req,timeout=a.timeout) as r, tmp.open('wb') as f: shutil.copyfileobj(r,f)
                    if is_pdf(tmp): tmp.replace(dest); ok=True; w['pdf_url']=url; break
                    tmp.unlink(missing_ok=True); notes.append(f'{url}: non-PDF payload')
                except Exception as e: notes.append(f'{url}: {e}')
        if ok:
            w['local_pdf_path']=str(dest); w['acquisition_status']=status_for(w.get('version_type','unknown')); w['access_note']='Verified PDF bundled.'
        else:
            if w.get('acquisition_status') not in UNAVAILABLE: w['acquisition_status']='download_failed' if notes else 'no_public_pdf_found'
            w['access_note']=(' '.join([str(w.get('access_note','')).strip(),'; '.join(notes)])).strip() or 'No lawful public PDF located.'
            w.pop('local_pdf_path',None)
        w['checked_date']=dt.date.today().isoformat(); out.append(w)
    result={'paper_title':d.get('metadata',{}).get('paper_title',''),'literature':out}; a.manifest_out.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8'); print(a.manifest_out)
if __name__=='__main__': main()
