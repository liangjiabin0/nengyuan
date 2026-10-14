"""Fail closed on missing native diagram coverage or stale final-render reviews.

This verifies artifacts and attestations, not scientific truth or visual aesthetics.
"""
import argparse
import hashlib
import json
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from validate_semantic_graph import read_json, require, validate_graph, validate_layout
from validate_contribution_map import validate as validate_contributions
from audit_template_bindings import audit as audit_bindings

NS = {'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def resolve(base, value):
    p = Path(value)
    return p if p.is_absolute() else base / p


def audit(spec_path, pptx, coverage_path, review_path):
    spec_path, pptx, coverage_path, review_path = map(Path, (spec_path, pptx, coverage_path, review_path))
    spec = read_json(spec_path)
    validate_contributions(spec,spec_path.parent)
    binding_check=audit_bindings(pptx)
    require(binding_check['passed'],'invalid template bindings: '+'; '.join(binding_check['errors']))
    s1 = spec['slide1']
    graph_path = resolve(spec_path.parent, s1['semanticGraphPath'])
    layout_path = resolve(spec_path.parent, s1['diagramLayoutPath'])
    graph, layout = read_json(graph_path), read_json(layout_path)
    validate_graph(graph, [f['id'] for f in s1.get('formulas', [])])
    validate_layout(graph, layout)
    coverage, review = read_json(coverage_path), read_json(review_path)
    if spec.get('meta',{}).get('contributionMapPath'):
        contribution_path=resolve(spec_path.parent,spec['meta']['contributionMapPath'])
        require(review.get('contributionMapSha256')==sha(contribution_path),'contributionMapSha256: review is missing or stale')
    with zipfile.ZipFile(pptx) as z:
        presentation = ET.fromstring(z.read('ppt/presentation.xml'))
        slide_ids = presentation.findall('p:sldIdLst/p:sldId', NS)
        require(len(slide_ids) == 2, 'final deck must contain exactly two slides')
        rels = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(z.read('ppt/_rels/presentation.xml.rels'))}
        target = rels[slide_ids[0].attrib['{' + NS['r'] + '}id']]
        import posixpath
        part = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('ppt', target))
        root = ET.fromstring(z.read(part))
        native = {}
        for typ in ('sp', 'cxnSp'):
            for element in root.findall('.//p:' + typ, NS):
                nv = element.find('.//p:cNvPr', NS)
                if nv is not None:
                    name = nv.get('name')
                    require(name not in native, f'duplicate native object name: {name}')
                    native[name] = element
        claimed = set()
        for category in ('nodes', 'edges'):
            expected = {v['id'] for v in graph[category]}
            require(set(coverage.get(category, {})) == expected, f'coverage must exactly cover {category}')
            for ident, names in coverage[category].items():
                require(isinstance(names, list) and names and all(isinstance(n, str) for n in names), f'{ident}: missing exported shape names')
                require(len(names) == len(set(names)), f'{ident}: duplicate mapped names')
                prefix = 'dg-' + ('node' if category == 'nodes' else 'edge') + '-' + ident + '-'
                require(all(n.startswith(prefix) and n in native for n in names), f'{ident}: mapped native diagram objects missing from final PPTX')
                require(not claimed.intersection(names), 'one native object cannot stand for multiple semantic entities')
                claimed.update(names)
                if category == 'edges':
                    # A text label or colored panel cannot masquerade as the relation itself.
                    paths = [n for n in names if '-segment-' in n]
                    require(paths, f'{ident}: native route segments are required')
                    for n in paths:
                        el = native[n]
                        geom = el.find('.//{http://schemas.openxmlformats.org/drawingml/2006/main}prstGeom')
                        require(el.tag.endswith('cxnSp') or (geom is not None and geom.get('prst') == 'line'), f'{ident}: route segment must be a native line/connector')
    for key, path in [('pptxSha256', pptx), ('graphSha256', graph_path), ('layoutSha256', layout_path), ('coverageSha256', coverage_path)]:
        require(review.get(key) == sha(path), f'{key}: review is missing or stale; inspect current final renders')
    slides = review.get('slides', [])
    require(isinstance(slides, list) and len(slides) == 2 and {s.get('slide') for s in slides} == {1, 2}, 'review must cover both final slides')
    for entry in slides:
        render = resolve(review_path.parent, entry.get('renderPath', ''))
        require(render.is_file() and render.stat().st_size > 0 and entry.get('renderSha256') == sha(render), 'missing or stale slide rendering')
        require(render.suffix.lower() in {'.png', '.jpg', '.jpeg'}, 'review must reference an inspectable slide image')
        checks = {'readable', 'noOverlap', 'templateMatch', 'evidenceFaithful', 'editable'}
        if entry['slide'] == 1:
            checks |= {'mechanismClear', 'notTextOnly', 'formulaAdjacency'}
        require(all(entry.get('checks', {}).get(k) is True for k in checks), f'slide {entry["slide"]}: unresolved visual review checks')
        require(len(entry.get('observations', '').strip()) >= 40, 'record concrete inspection observations, not a blanket PASS')
    return {'slides': 2, 'nativeDiagramObjects': len(claimed), 'reviewBoundToCurrentFiles': True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('spec', 'pptx', 'coverage', 'review'):
        p.add_argument(name)
    args = p.parse_args()
    try:
        print('PASS: ' + json.dumps(audit(args.spec, args.pptx, args.coverage, args.review)))
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, ET.ParseError) as exc:
        p.exit(1, f'ERROR: {exc}\n')


if __name__ == '__main__':
    main()
