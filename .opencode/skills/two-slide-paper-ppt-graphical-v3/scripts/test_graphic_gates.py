"""Regression tests using synthetic software fixtures, not research evidence.

Optional: --emit-fixture DIR writes data for an actual artifact-tool export smoke test.
"""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from validate_semantic_graph import validate_graph, validate_layout


def fixture():
    ref = 'Synthetic software test fixture, not a manuscript claim'
    nodes = [
        {'id': 'ems', 'type': 'optimizer', 'label': 'EMS', 'evidenceRef': ref},
        {'id': 'controller', 'type': 'controller', 'label': 'Controller', 'evidenceRef': ref},
        {'id': 'plant', 'type': 'plant', 'label': 'GFM', 'evidenceRef': ref},
        {'id': 'battery', 'type': 'device', 'label': 'Storage', 'evidenceRef': ref},
        {'id': 'load', 'type': 'device', 'label': 'Load', 'evidenceRef': ref},
    ]
    edges = [
        ('reference', 'ems', 'controller', 'control', 'Reference'),
        ('actuation', 'controller', 'plant', 'control', 'Control'),
        ('measurement', 'plant', 'controller', 'feedback', 'Measured state'),
        ('supply', 'battery', 'plant', 'power', 'Power'),
        ('demand', 'plant', 'load', 'power', 'Power'),
    ]
    graph = {'schemaVersion': 1, 'profile': 'control', 'nodes': nodes,
             'edges': [dict(zip(('id', 'from', 'to', 'kind', 'label'), row), evidenceRef=ref) for row in edges],
             'mechanisms': [{'id': 'loop', 'kind': 'feedback', 'nodeIds': ['controller','plant'], 'edgeIds': ['actuation','measurement'], 'evidenceRef': ref}], 'formulaLinks': []}
    layout = {'canvas': {'width':1280,'height':720}, 'contentFrame': {'x':30,'y':225,'w':1220,'h':415},
              'diagramFrame': {'x':30,'y':225,'w':1220,'h':415}, 'fontFamily':'Microsoft YaHei','fontSize':22,
              'nodes': {
                  'ems': {'x':80,'y':240,'w':200,'h':90,'glyph':'optimizer'},
                  'controller': {'x':430,'y':240,'w':220,'h':90,'glyph':'controller'},
                  'plant': {'x':450,'y':450,'w':180,'h':140,'glyph':'converter'},
                  'battery': {'x':80,'y':450,'w':180,'h':140,'glyph':'battery'},
                  'load': {'x':940,'y':450,'w':180,'h':140,'glyph':'load'},
              }, 'edges': {
                  'reference': {'points':[[280,285],[430,285]], 'labelBox':{'x':290,'y':245,'w':130,'h':30}},
                  'actuation': {'points':[[500,330],[500,450]], 'labelBox':{'x':350,'y':368,'w':140,'h':30}},
                  'measurement': {'points':[[630,480],[800,480],[800,285],[650,285]], 'labelBox':{'x':825,'y':350,'w':225,'h':34}},
                  'supply': {'points':[[260,520],[450,520]], 'labelBox':{'x':290,'y':480,'w':130,'h':30}},
                  'demand': {'points':[[630,550],[940,550]], 'labelBox':{'x':710,'y':570,'w':150,'h':30}},
              }}
    modules = [ {'title':x,'conclusion':'Synthetic fixture','evidenceRef':ref,'visuals':[{'type':'table','headers':['fixture','value'],'rows':[['test','1']],'evidenceRef':ref}]} for x in ('A','B','C') ]
    spec = {'meta': {'paperTitle':'Synthetic renderer test','paperType':'control','slideSize':layout['canvas']},
            'slide1': {'title':'Control loop fixture','summaryRuns':[{'text':'Software test only'}], 'methodModelPath':'model.md','semanticGraphPath':'semantic-graph.json','diagramLayoutPath':'diagram-layout.json','panels':[{'title':'System','conclusion':'Control loop','evidenceRef':ref}],'formulas':[]},
            'slide2': {'title':'Test results fixture','summaryRuns':[{'text':'Software test only'}], 'resultModules':modules}}
    return graph, layout, spec


def emit(directory):
    directory = Path(directory); directory.mkdir(parents=True,exist_ok=True)
    graph, layout, spec = fixture()
    for name, data in [('semantic-graph.json',graph),('diagram-layout.json',layout),('spec.json',spec)]:
        (directory/name).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    (directory/'model.md').write_text('Synthetic control-loop test fixture; no manuscript claims.',encoding='utf-8')
    return directory


class GraphRegression(unittest.TestCase):
    def setUp(self):
        self.g, self.l, self.s = fixture()

    def test_valid_control(self):
        validate_graph(self.g, [])
        validate_layout(self.g,self.l)

    def test_deleted_feedback_is_rejected(self):
        self.g['edges'] = [e for e in self.g['edges'] if e['id']!='measurement']
        self.g['mechanisms'][0]['edgeIds']=['actuation']
        with self.assertRaisesRegex(ValueError,'closed directed path'): validate_graph(self.g)

    def test_text_only_rejected(self):
        self.g['edges']=[]
        with self.assertRaisesRegex(ValueError,'explicit relationships'): validate_graph(self.g)

    def test_isolated_card_rejected(self):
        self.g['nodes'].append({'id':'unused','type':'operation','label':'Extra paragraph','evidenceRef':'fixture'})
        with self.assertRaisesRegex(ValueError,'isolated'): validate_graph(self.g)

    def test_detached_arrow_rejected(self):
        self.l['edges']['reference']['points'][0]=[350,250]
        with self.assertRaisesRegex(ValueError,'detached'): validate_layout(self.g,self.l)

    def test_tiny_font_rejected(self):
        self.l['fontSize']=10
        with self.assertRaisesRegex(ValueError,'10 pt'): validate_layout(self.g,self.l)

    def test_missing_formula_relation_rejected(self):
        with self.assertRaisesRegex(ValueError,'exactly cover'): validate_graph(self.g,['eq1'])

    def test_fake_branch_rejected(self):
        self.g['mechanisms'][0]['kind']='branch'
        with self.assertRaisesRegex(ValueError,'decision'): validate_graph(self.g)

    def test_duplicate_ids_rejected(self):
        self.g['nodes'].append(copy.deepcopy(self.g['nodes'][0]))
        with self.assertRaisesRegex(ValueError,'unique'): validate_graph(self.g)

    def test_linear_method_needs_evidence_but_is_allowed(self):
        g=copy.deepcopy(self.g)
        g['profile']='forecasting';g['nodes']=g['nodes'][:2];g['edges']=g['edges'][:1]
        g['mechanisms']=[{'id':'sequence','kind':'sequence','nodeIds':['ems','controller'],'edgeIds':['reference'],'evidenceRef':'fixture'}]
        with self.assertRaisesRegex(ValueError,'linearJustification'):validate_graph(g)
        g['linearJustification']={'reason':'This synthetic fixture has only a serial dependency and no additional paths.','evidenceRef':'fixture'}
        validate_graph(g)

    def test_spec_requires_real_graph_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=emit(tmp)
            script=Path(__file__).with_name('validate_two_slide_spec.py')
            result=subprocess.run([sys.executable,str(script),str(d/'spec.json')],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            (d/'semantic-graph.json').unlink()
            result=subprocess.run([sys.executable,str(script),str(d/'spec.json')],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('does not exist',result.stdout+result.stderr)

    def test_old_spec_without_graph_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=emit(tmp); self.s['slide1'].pop('semanticGraphPath')
            (d/'spec.json').write_text(json.dumps(self.s),encoding='utf-8')
            result=subprocess.run([sys.executable,str(Path(__file__).with_name('validate_two_slide_spec.py')),str(d/'spec.json')],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('semanticGraphPath',result.stdout+result.stderr)


if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--emit-fixture':
        print(emit(sys.argv[2]))
    else:
        unittest.main()
