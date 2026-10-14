"""Regression for a package-valid but PowerPoint-incompatible template import."""
import tempfile,unittest,zipfile
from pathlib import Path
from audit_template_bindings import audit,P,R

REL='http://schemas.openxmlformats.org/package/2006/relationships'
def fixture(path,listed='1',registered=True):
    def rel(kind,target,ident='r1'):
        return f'<Relationships xmlns="{REL}"><Relationship Id="{ident}" Type="{R}/{kind}" Target="{target}"/></Relationships>'
    parts={
        'ppt/presentation.xml':f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldMasterIdLst>'+ (f'<p:sldMasterId r:id="rm"/>' if registered else '') +'</p:sldMasterIdLst><p:sldIdLst><p:sldId r:id="rs"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels':f'<Relationships xmlns="{REL}"><Relationship Id="rm" Type="{R}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rs" Type="{R}/slide" Target="slides/slide1.xml"/></Relationships>',
        'ppt/slides/_rels/slide1.xml.rels':rel('slideLayout','../slideLayouts/slideLayout1.xml'),
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels':rel('slideMaster','../slideMasters/slideMaster1.xml'),
        'ppt/slideMasters/slideMaster1.xml':f'<p:sldMaster xmlns:p="{P}" xmlns:r="{R}"><p:sldLayoutIdLst><p:sldLayoutId r:id="r1"/></p:sldLayoutIdLst></p:sldMaster>',
        'ppt/slideMasters/_rels/slideMaster1.xml.rels':rel('slideLayout','../slideLayouts/slideLayout'+listed+'.xml')}
    with zipfile.ZipFile(path,'w') as z:
        for n,v in parts.items():z.writestr(n,v)

class BindingTests(unittest.TestCase):
    def check(self,**kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'fixture.pptx';fixture(p,**kwargs);return audit(p)
    def test_valid_reciprocal_binding(self):self.assertTrue(self.check()['passed'])
    def test_stale_layout_after_master_copy(self):
        r=self.check(listed='2');self.assertFalse(r['passed']);self.assertIn('absent',r['errors'][0])
    def test_unregistered_master(self):
        r=self.check(registered=False);self.assertFalse(r['passed']);self.assertIn('not registered',r['errors'][0])

if __name__=='__main__':unittest.main()
