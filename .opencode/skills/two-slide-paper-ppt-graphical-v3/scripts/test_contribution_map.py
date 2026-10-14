"""Synthetic regression fixtures; these values are not manuscript evidence."""
import copy,json,tempfile,unittest
from pathlib import Path
from validate_contribution_map import validate

def fixture():
    graph={'nodes':[{'id':'decision','type':'decision'},{'id':'short','type':'optimizer'},{'id':'long','type':'optimizer'}],
           'edges':[{'from':'decision','to':'short','kind':'decision'},{'from':'decision','to':'long','kind':'decision'}]}
    spec={'meta':{'documentKind':'thesis','contributionMapPath':'map.json'},'slide1':{'semanticGraphPath':'graph.json'},
          'slide2':{'resultModules':[{'id':'short-results','caseIds':['case1'],'claimStatus':'validated'},
                                     {'id':'long-results','caseIds':['case2'],'claimStatus':'validated'}]}}
    mapping={'schemaVersion':1,'sourceStructure':[
        {'chapter':'2','role':'core','contributionId':'short','evidenceRef':'synthetic'},
        {'chapter':'3','role':'core','contributionId':'long','evidenceRef':'synthetic'}],
        'contributions':[{'id':i,'title':i,'evidenceRef':'synthetic','methodNodeIds':[i],
                          'resultModuleIds':[i+'-results'],'validationStatus':'simulated'} for i in ('short','long')],
        'relations':[{'kind':'alternative','decisionNodeId':'decision','targetNodeIds':['short','long'],'evidenceRef':'synthetic'}],
        'cases':[{'id':i,'inputStatus':'constructed','description':'Synthetic case','evidenceRef':'synthetic'} for i in ('case1','case2')],
        'quantities':[{'id':i,'value':v,'metric':'annual-net-cost','unit':'currency/year','basis':'cost-minus-benefit',
                       'horizon':'annual','caseId':'case1','evidenceRef':'synthetic'} for i,v in [('before',100),('after',80)]],
        'comparisons':[{'left':'before','right':'after','mode':'percent-reduction','value':20,'evidenceRef':'synthetic'}]}
    return spec,graph,mapping

class ContributionTests(unittest.TestCase):
    def setUp(self):self.s,self.g,self.m=fixture()
    def run_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp)
            (d/'map.json').write_text(json.dumps(self.m),encoding='utf-8')
            (d/'graph.json').write_text(json.dumps(self.g),encoding='utf-8')
            return validate(self.s,d)
    def test_valid(self):self.assertEqual(self.run_gate()['contributions'],2)
    def test_single_paper_does_not_require_map(self):
        self.assertFalse(validate({'meta':{}},Path('.'))['applicable'])
    def test_thesis_requires_map(self):
        del self.s['meta']['contributionMapPath']
        with self.assertRaisesRegex(ValueError,'requires contributionMapPath'):self.run_gate()
    def test_omitted_core_chapter(self):
        self.m['contributions'].pop()
        with self.assertRaisesRegex(ValueError,'core chapter omitted'):self.run_gate()
    def test_missing_method_node(self):
        self.m['contributions'][0]['methodNodeIds']=['absent']
        with self.assertRaisesRegex(ValueError,'method nodes'):self.run_gate()
    def test_missing_result_region(self):
        self.m['contributions'][0]['resultModuleIds']=[]
        with self.assertRaisesRegex(ValueError,'result evidence'):self.run_gate()
    def test_alternative_cannot_be_serial(self):
        self.g['edges'].append({'from':'short','to':'long','kind':'sequence'})
        with self.assertRaisesRegex(ValueError,'serial treatment'):self.run_gate()
    def test_missing_branch(self):
        self.g['edges'].pop()
        with self.assertRaisesRegex(ValueError,'branches are absent'):self.run_gate()
    def test_unvalidated_method_claim(self):
        self.m['contributions'][1].update(validationStatus='method-only',validationBoundary='Proposed only')
        with self.assertRaisesRegex(ValueError,'cannot be claimed'):self.run_gate()
    def test_unused_forecast_input_claim(self):
        self.m['cases'][1]['inputStatus']='method-only'
        with self.assertRaisesRegex(ValueError,'not experimental validation'):self.run_gate()
    def test_incompatible_bases(self):
        for key,value in [('metric','annual-planning-cost'),('unit','USD'),('basis','investment-only'),('horizon','lifetime'),('caseId','case2')]:
            with self.subTest(key=key):
                old=self.m['quantities'][1][key];self.m['quantities'][1][key]=value
                with self.assertRaisesRegex(ValueError,'incompatible'):self.run_gate()
                self.m['quantities'][1][key]=old
    def test_wrong_arithmetic(self):
        self.m['comparisons'][0]['value']=25
        with self.assertRaisesRegex(ValueError,'does not match'):self.run_gate()
    def test_side_by_side_requires_visible_caveat(self):
        self.m['quantities'][1]['basis']='investment-only';self.m['comparisons'][0]['mode']='side-by-side'
        with self.assertRaisesRegex(ValueError,'visible caveat'):self.run_gate()
        self.m['comparisons'][0]['visibleCaveat']='Different accounting bases; do not calculate savings.'
        self.s['slide2']['caveat']=self.m['comparisons'][0]['visibleCaveat']
        self.run_gate()
    def test_nonfinite_data(self):
        self.m['quantities'][1]['value']=float('nan')
        with self.assertRaisesRegex(ValueError,'finite value'):self.run_gate()

if __name__=='__main__':unittest.main()
