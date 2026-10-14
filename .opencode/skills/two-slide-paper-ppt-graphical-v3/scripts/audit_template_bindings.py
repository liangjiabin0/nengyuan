"""Check slide/layout/master reciprocity; package existence checks alone miss this.

This does not replace opening and rendering the final PPTX in PowerPoint.
"""
import json,posixpath,sys,zipfile
from xml.etree import ElementTree as ET

P='http://schemas.openxmlformats.org/presentationml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def audit(path):
    errors=[];count=0
    with zipfile.ZipFile(path) as z:
        def rels(part):
            directory,name=posixpath.split(part)
            root=ET.fromstring(z.read(posixpath.join(directory,'_rels',name+'.rels')))
            return {r.get('Id'):(r.get('Type','').rsplit('/',1)[-1],
                    r.get('Target','').lstrip('/') if r.get('Target','').startswith('/') else
                    posixpath.normpath(posixpath.join(directory,r.get('Target',''))))
                    for r in root if r.get('TargetMode')!='External'}
        def refs(part,tag):
            root=ET.fromstring(z.read(part));rr=rels(part)
            return [rr[e.get('{'+R+'}id')][1] for e in root.findall('.//{'+P+'}'+tag)]
        masters=set(refs('ppt/presentation.xml','sldMasterId'))
        for slide in refs('ppt/presentation.xml','sldId'):
            count+=1
            layouts=[t for kind,t in rels(slide).values() if kind=='slideLayout']
            if len(layouts)!=1:
                errors.append(slide+': exactly one layout required');continue
            layout=layouts[0]
            owners=[t for kind,t in rels(layout).values() if kind=='slideMaster']
            if len(owners)!=1:
                errors.append(layout+': exactly one master required');continue
            master=owners[0]
            if master not in masters:errors.append(slide+': layout master is not registered in presentation')
            if layout not in refs(master,'sldLayoutId'):
                errors.append(slide+': layout is absent from owning master layout list')
    return {'passed':not errors,'slides':count,'errors':errors}

if __name__=='__main__':
    try:
        if len(sys.argv)!=2:raise ValueError('usage: audit_template_bindings.py deck.pptx')
        result=audit(sys.argv[1]);print(json.dumps(result));raise SystemExit(0 if result['passed'] else 1)
    except (KeyError,ValueError,OSError,ET.ParseError,zipfile.BadZipFile) as e:
        raise SystemExit('ERROR: '+str(e))
