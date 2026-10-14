"""Coverage and comparison gate for multi-contribution sources. No third-party dependencies."""
import json,math,sys
from pathlib import Path
from validate_semantic_graph import read_json,require,nonempty

def resolve(base,value):
    p=Path(value);return p if p.is_absolute() else base/p

def strings(obj):
    if isinstance(obj,dict):
        for k,v in obj.items():
            if k not in {'evidenceRef','assetPath','latex'}:yield from strings(v)
    elif isinstance(obj,list):
        for v in obj:yield from strings(v)
    elif isinstance(obj,str):yield obj

def validate(spec,base):
    path=spec.get('meta',{}).get('contributionMapPath')
    required=spec.get('meta',{}).get('documentKind') in {'thesis','multi-contribution-paper'}
    require(not required or nonempty(path),'multi-contribution source requires contributionMapPath')
    if not path:return {'applicable':False}
    m=read_json(resolve(base,path));require(m.get('schemaVersion')==1,'contribution map schemaVersion must be 1')
    graph=read_json(resolve(base,spec['slide1']['semanticGraphPath']))
    nodes={n['id'] for n in graph['nodes']};edges=graph['edges']
    rawmodules=spec['slide2'].get('resultModules',[])
    require(rawmodules and all(nonempty(x.get('id')) for x in rawmodules),'multi-contribution results need identified resultModules')
    modules={x['id']:x for x in rawmodules};require(len(modules)==len(rawmodules),'duplicate result module IDs')
    contributions=m.get('contributions',[])
    ids={c.get('id') for c in contributions}
    require(contributions and None not in ids and len(ids)==len(contributions),'contribution IDs must be present and unique')
    structure=m.get('sourceStructure',[])
    require(structure and any(s.get('role')=='core' for s in structure),'record the core source chapters')
    for s in structure:
        require(nonempty(s.get('chapter')) and nonempty(s.get('evidenceRef')),'chapter needs evidence')
        require(s.get('role') in {'core','supporting','background'},'invalid chapter role')
        if s['role']=='core':require(s.get('contributionId') in ids,'core chapter omitted from contributions')
    covered=set()
    for c in contributions:
        cn=set(c.get('methodNodeIds',[]));rm=set(c.get('resultModuleIds',[]))
        require(cn and cn<=nodes,'contribution missing actual method nodes')
        require(rm and rm<=set(modules),'contribution missing result evidence region')
        require(nonempty(c.get('title')) and nonempty(c.get('evidenceRef')),'contribution needs title and source')
        require(c.get('validationStatus') in {'simulated','measured','method-only'},'invalid validationStatus')
        if c['validationStatus']=='method-only':
            require(nonempty(c.get('validationBoundary')),'method-only contribution needs explicit evidence boundary')
            require(all(modules[i].get('claimStatus')!='validated' for i in rm),'method-only contribution cannot be claimed as validated')
        covered|=rm
    require(covered==set(modules),'unmapped result theme')
    for r in m.get('relations',[]):
        require(nonempty(r.get('evidenceRef')),'contribution relation needs evidence')
        if r.get('kind')=='alternative':
            decision=r.get('decisionNodeId');targets=set(r.get('targetNodeIds',[]))
            require(any(n['id']==decision and n['type']=='decision' for n in graph['nodes']),'alternatives require an actual decision node')
            require(len(targets)>=2 and targets<=nodes,'alternatives need at least two target nodes')
            require(targets<={e['to'] for e in edges if e['from']==decision},'alternative branches are absent from semantic graph')
            require(not any(e['from'] in targets and e['to'] in targets and e['kind']=='sequence' for e in edges),'alternatives cannot be directly drawn as a serial treatment sequence')
        else:
            require(r.get('kind') in {'coupling','sequence','shared-assessment'} and set(r.get('nodeIds',[]))<=nodes and r.get('nodeIds'),'invalid contribution relation')
    cases={c.get('id'):c for c in m.get('cases',[])}
    require(cases and None not in cases and len(cases)==len(m['cases']),'case IDs must be present and unique')
    for c in cases.values():
        require(c.get('inputStatus') in {'historical','constructed','forecast-used','method-only'} and nonempty(c.get('description')) and nonempty(c.get('evidenceRef')),'case needs input status, description and evidence')
    for module in modules.values():
        mc=set(module.get('caseIds',[]));require(mc and mc<=set(cases),'result theme needs known caseIds')
        if module.get('claimStatus')=='validated':
            require(all(cases[x]['inputStatus']!='method-only' for x in mc),'a method-only input is not experimental validation')
    quantities={q.get('id'):q for q in m.get('quantities',[])}
    require(None not in quantities and len(quantities)==len(m.get('quantities',[])),'quantity IDs must be unique')
    for q in quantities.values():
        require(isinstance(q.get('value'),(int,float)) and not isinstance(q['value'],bool) and math.isfinite(q['value']),'quantity needs a finite value')
        require(all(nonempty(q.get(k)) for k in ('metric','unit','basis','horizon','evidenceRef')) and q.get('caseId') in cases,'quantity missing accounting/scenario scope')
    visible='\n'.join(strings({'slide1':spec['slide1'],'slide2':spec['slide2']}))
    for c in m.get('comparisons',[]):
        require(c.get('left') in quantities and c.get('right') in quantities and nonempty(c.get('evidenceRef')),'comparison needs known operands and evidence')
        a,b=quantities[c['left']],quantities[c['right']]
        compatible=all(a[k]==b[k] for k in ('metric','unit','basis','horizon','caseId'))
        mode=c.get('mode');require(mode in {'percent-reduction','difference','side-by-side'},'unsupported comparison mode')
        if mode=='side-by-side':
            if not compatible:require(nonempty(c.get('visibleCaveat')) and c['visibleCaveat'] in visible,'incompatible side-by-side comparison needs a visible caveat')
        else:
            require(compatible,'incompatible cost/metric/scenario bases cannot be compared arithmetically')
            require(mode!='percent-reduction' or a['value']>0,'percent reduction requires positive baseline')
            expected=(a['value']-b['value'])/a['value']*100 if mode=='percent-reduction' else a['value']-b['value']
            require(isinstance(c.get('value'),(int,float)) and math.isfinite(c['value']) and abs(c['value']-expected)<=0.011,'computed comparison does not match operands')
    return {'applicable':True,'contributions':len(contributions),'cases':len(cases),'comparisons':len(m.get('comparisons',[]))}

if __name__=='__main__':
    try:
        require(len(sys.argv)==2,'usage: validate_contribution_map.py spec.json')
        p=Path(sys.argv[1]);print('PASS: '+json.dumps(validate(read_json(p),p.parent)))
    except (ValueError,KeyError,TypeError,OSError) as e:raise SystemExit('ERROR: '+str(e))
