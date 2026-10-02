import json
import os
from pathlib import Path
import re
import subprocess
import sys
import pymupdf

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    repo=Path(__file__).resolve().parent.parent
    root=Path(sys.argv[1] if len(sys.argv)>1 else 'F:/数据')/'论文信息'
    pdfs={p.stem:p for p in root.rglob('*.pdf')}
    cajs=list(root.rglob('*.caj'))
    work=repo/'storage'/'convert-work'/'caj-coverage'
    work.mkdir(parents=True,exist_ok=True)
    os.environ['PATH']=str(repo/'tools')+os.pathsep+os.environ['PATH']
    direct=0; aliases=[]; missing=[]
    for caj in cajs:
        if caj.stem in pdfs: direct+=1; continue
        alias=re.sub(r' \(1\)$','',caj.stem)
        if alias not in pdfs: missing.append(str(caj));continue
        output=work/f'duplicate-{len(aliases)+1}.pdf'
        conversion=subprocess.run([sys.executable,str(repo/'tools'/'caj2pdf-fresh'/'caj2pdf-master'/'caj2pdf'),'convert',str(caj),'-o',str(output)],cwd=work,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
        item={'caj':str(caj),'pdf':str(pdfs[alias]),'convertedFile':str(output),'converted':conversion.returncode==0}
        if conversion.returncode==0:
            a=pymupdf.open(str(output));b=pymupdf.open(str(pdfs[alias]))
            norm=lambda d:re.sub(r'\s+','', ''.join(p.get_text() for p in d))
            item.update({'pages':len(a),'matchedPages':len(b),'sameExtractedText':norm(a)==norm(b)})
            a.close();b.close()
        else:item['error']=conversion.stderr.decode('utf-8',errors='replace')
        aliases.append(item)
    report={'total':len(cajs),'directPdfMatches':direct,'duplicateNameMatches':aliases,'withoutPdf':missing}
    (repo/'storage'/'caj-coverage.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
