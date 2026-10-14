"""Extract accepted text, comments and tracked changes without executing document content."""
import argparse,json,zipfile
from pathlib import Path
from lxml import etree
NS={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','m':'http://schemas.openxmlformats.org/officeDocument/2006/math'}
W='{'+NS['w']+'}'
def content(el,accepted=False):
    nodes=el.xpath('.//w:t | .//w:delText | .//m:t',namespaces=NS)
    return ''.join((n.text or '') for n in nodes if not accepted or not any(a.tag==W+'del' for a in n.iterancestors()))
def extract(path):
    with zipfile.ZipFile(path) as z:
        doc=etree.fromstring(z.read('word/document.xml'));paras=doc.xpath('//w:body//w:p',namespaces=NS)
        entries=[];active=set();anchors={}
        for index,para in enumerate(paras,1):
            ids=set(active)
            for node in para.iter():
                if node.tag==W+'commentRangeStart': active.add(node.get(W+'id'));ids.add(node.get(W+'id'))
                elif node.tag==W+'commentReference':ids.add(node.get(W+'id'))
                elif node.tag==W+'commentRangeEnd':ids.add(node.get(W+'id'));active.discard(node.get(W+'id'))
            e={'paragraph':index,'accepted_text':content(para,True),'all_revision_text':content(para)}
            entries.append(e)
            for cid in ids:anchors.setdefault(cid,[]).append(e)
        comments=[]
        if 'word/comments.xml' in z.namelist():
            for c in etree.fromstring(z.read('word/comments.xml')).xpath('//w:comment',namespaces=NS):
                cid=c.get(W+'id');comments.append({'id':cid,'text':content(c),'author':c.get(W+'author'),'date':c.get(W+'date'),'anchors':anchors.get(cid,[])})
        changes=[]
        for index,para in enumerate(paras,1):
            for node in para.xpath('.//w:ins | .//w:del',namespaces=NS):
                changes.append({'paragraph':index,'kind':etree.QName(node).localname,'text':content(node),'context':content(para),'accepted_context':content(para,True),'author':node.get(W+'author'),'date':node.get(W+'date')})
        return {'source':str(path),'paragraphs':entries,'comments':comments,'changes':changes}
def main():
    ap=argparse.ArgumentParser();ap.add_argument('input_docx',type=Path);ap.add_argument('--output',required=True,type=Path);a=ap.parse_args()
    result=extract(a.input_docx);a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'paragraphs':len(result['paragraphs']),'comments':len(result['comments']),'changes':len(result['changes'])}))
if __name__=='__main__':main()
