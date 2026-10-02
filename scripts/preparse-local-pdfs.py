"""Pre-extract PDF text into the app's cache, without changing source files."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sys
import time

REPO = Path(__file__).resolve().parent.parent
CACHE = REPO / 'storage' / 'convert-work' / 'md'
sys.path.insert(0, str(REPO / 'tools' / 'pdf2md'))
import pdf_to_md
pdf_to_md.eprint = lambda *args: None

def extract(file):
    try:
        src = Path(file)
        with src.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha1').hexdigest()
        md = CACHE / (digest + '.md')
        meta = CACHE / (digest + '.json')
        if md.exists() and meta.exists():
            result = json.loads(meta.read_text(encoding='utf-8'))
        else:
            result = pdf_to_md.convert_pdf(str(src), str(md), str(meta), ocr_mode='never')
        return {'file':file, 'hash':digest, 'pages':result['numpages'], 'chars':result['chars']}
    except Exception as error:
        return {'file':file, 'error':str(error)}

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    root = Path(sys.argv[1] if len(sys.argv)>1 else 'F:/数据')
    CACHE.mkdir(parents=True, exist_ok=True)
    files = [str(p) for folder in ['论文信息','专利信息'] for p in (root/folder).rglob('*.pdf')]
    report = {'root':str(root), 'total':len(files), 'processed':0, 'sparse':[], 'errors':[], 'startedAt':time.time()}
    target = REPO/'storage'/'pdf-preparse-progress.json'
    with concurrent.futures.ProcessPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(extract,file):file for file in files}
        with (REPO/'storage'/'pdf-preparse-files.jsonl').open('a',encoding='utf-8') as audit:
            for future in concurrent.futures.as_completed(futures):
                result = future.result()
                audit.write(json.dumps(result,ensure_ascii=False)+'\n')
                report['processed'] += 1
                if 'error' in result: report['errors'].append(result)
                elif result['chars'] < 80: report['sparse'].append(result)
                if report['processed'] % 100 == 0 or report['processed']==len(files):
                    report['updatedAt']=time.time()
                    target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
                    print(f"PDF text cache {report['processed']}/{len(files)} sparse={len(report['sparse'])} errors={len(report['errors'])}",flush=True)
    report['completedAt']=time.time()
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
