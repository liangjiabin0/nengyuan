"""Structural gate for the shared, source-grounded slide-1 semantic graph."""
import argparse
import json
import math
import re
from pathlib import Path

PROFILES = {'planning', 'operation', 'market', 'control', 'detection', 'forecasting'}
NODE_TYPES = {'input', 'output', 'device', 'bus', 'plant', 'controller', 'optimizer', 'agent', 'state', 'operation', 'decision', 'sum', 'constraint', 'data'}
EDGE_TYPES = {'power', 'information', 'control', 'feedback', 'price', 'response', 'decision', 'iteration', 'data', 'sequence'}
MECHANISMS = {'feedback', 'branch', 'coupling', 'hierarchy', 'parallel', 'physical-network', 'sequence'}
GLYPHS = {'process', 'optimizer', 'controller', 'decision', 'sum', 'bus', 'battery', 'converter', 'solar', 'load', 'user', 'data'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def has_cycle(ids, edges):
    adj = {n: [] for n in ids}
    for e in edges:
        adj[e['from']].append(e['to'])
    active, done = set(), set()
    def visit(n):
        if n in active:
            return True
        if n in done:
            return False
        active.add(n)
        if any(visit(v) for v in adj[n]):
            return True
        active.remove(n)
        done.add(n)
        return False
    return any(visit(n) for n in ids)


def validate_graph(graph, formula_ids=None):
    require(graph.get('schemaVersion') == 1, 'semantic graph schemaVersion must be 1')
    require(graph.get('profile') in PROFILES, 'unknown semantic graph profile')
    nodes, edges = graph.get('nodes', []), graph.get('edges', [])
    require(isinstance(nodes, list) and len(nodes) >= 2, 'semantic graph needs at least two source-grounded nodes')
    require(isinstance(edges, list) and edges, 'semantic graph needs explicit relationships, not only text cards')
    for values, allowed, type_key in [(nodes, NODE_TYPES, 'type'), (edges, EDGE_TYPES, 'kind')]:
        ids = set()
        for v in values:
            require(isinstance(v, dict), 'graph entries must be objects')
            ident = v.get('id', '')
            require(isinstance(ident, str) and re.fullmatch(r'[A-Za-z0-9_-]+', ident) and ident not in ids, 'graph IDs must be valid and unique')
            ids.add(ident)
            require(v.get(type_key) in allowed, f'{ident}: unsupported {type_key}')
            require(nonempty(v.get('label')), f'{ident}: missing explanatory label')
            require(nonempty(v.get('evidenceRef')), f'{ident}: missing source evidence')
    ns, es = {n['id'] for n in nodes}, {e['id'] for e in edges}
    nd = {n['id']: n for n in nodes}
    for e in edges:
        require(e.get('from') in ns and e.get('to') in ns, f'{e["id"]}: unknown endpoint')
        require(e['from'] != e['to'], f'{e["id"]}: expand a self-loop into its actual operations')
    used = {e[k] for e in edges for k in ('from', 'to')}
    require(used == ns, f'isolated text-only nodes: {sorted(ns-used)}')
    mechanisms = graph.get('mechanisms', [])
    require(isinstance(mechanisms, list) and mechanisms, 'identify the contribution-defining mechanisms')
    mids = set()
    for m in mechanisms:
        require(nonempty(m.get('id')) and m['id'] not in mids, 'mechanism IDs must be unique')
        mids.add(m['id'])
        kind = m.get('kind')
        require(kind in MECHANISMS and nonempty(m.get('evidenceRef')), 'mechanism needs a supported kind and evidence')
        mn, me = set(m.get('nodeIds', [])), set(m.get('edgeIds', []))
        require(mn and mn <= ns and me and me <= es, f'{m["id"]}: mechanism references unknown or absent nodes/edges')
        subset = [e for e in edges if e['id'] in me]
        require(all(e['from'] in mn and e['to'] in mn for e in subset), f'{m["id"]}: mechanism must include its edge endpoints')
        if kind == 'feedback':
            require(has_cycle(mn, subset), f'{m["id"]}: declared feedback lacks a closed directed path')
        if kind == 'branch':
            require(any(nd[n]['type'] == 'decision' and len({e['to'] for e in subset if e['from'] == n}) >= 2 for n in mn), f'{m["id"]}: branch needs a decision with two outgoing destinations')
        if kind in {'parallel', 'physical-network'}:
            require(len(mn) >= 3 and len(me) >= 2, f'{m["id"]}: insufficient nodes/edges for {kind}')
    indeg = {n: sum(e['to'] == n for e in edges) for n in ns}
    outdeg = {n: sum(e['from'] == n for e in edges) for n in ns}
    simple = not has_cycle(ns, edges) and max(indeg.values()) <= 1 and max(outdeg.values()) <= 1
    if simple:
        justification = graph.get('linearJustification') or {}
        require(len(justification.get('reason', '').strip()) >= 20 and nonempty(justification.get('evidenceRef')), 'a plain linear chain needs a source-based linearJustification; do not invent branches to bypass this')
    links = graph.get('formulaLinks', [])
    require(isinstance(links, list), 'formulaLinks must be a list')
    linked = set()
    for f in links:
        require(nonempty(f.get('formulaId')) and f['formulaId'] not in linked, 'formula links must use unique formula IDs')
        linked.add(f['formulaId'])
        fn, fe = set(f.get('nodeIds', [])), set(f.get('edgeIds', []))
        require((fn or fe) and fn <= ns and fe <= es and nonempty(f.get('evidenceRef')), 'formula links need valid semantic targets and evidence')
    if formula_ids is not None:
        require(linked == set(formula_ids), f'formula links must exactly cover displayed formulas; missing={set(formula_ids)-linked}, extra={linked-set(formula_ids)}')
    return {'nodes': len(nodes), 'edges': len(edges), 'mechanisms': len(mechanisms)}


def finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def box(v):
    return isinstance(v, dict) and all(finite(v.get(k)) for k in ('x', 'y', 'w', 'h')) and v['w'] > 0 and v['h'] > 0


def inside(a, b):
    return a['x'] >= b['x'] and a['y'] >= b['y'] and a['x']+a['w'] <= b['x']+b['w'] and a['y']+a['h'] <= b['y']+b['h']


def on_boundary(p, b, tol=3):
    x, y = p
    return b['x']-tol <= x <= b['x']+b['w']+tol and b['y']-tol <= y <= b['y']+b['h']+tol and min(abs(x-b['x']), abs(x-b['x']-b['w']), abs(y-b['y']), abs(y-b['y']-b['h'])) <= tol


def validate_layout(graph, layout):
    canvas = layout.get('canvas', {})
    require(all(finite(canvas.get(k)) and canvas[k] > 0 for k in ('width', 'height')), 'layout needs a positive canvas')
    frame = {'x': 0, 'y': 0, 'w': canvas['width'], 'h': canvas['height']}
    content, diagram = layout.get('contentFrame'), layout.get('diagramFrame')
    require(box(content) and box(diagram) and inside(content, frame) and inside(diagram, content), 'content and diagram frames must fit the canvas')
    if diagram['w']*diagram['h'] < .45*content['w']*content['h']:
        require(len(layout.get('compactDiagramReason', '').strip()) >= 20, 'method diagram is too small without an equation-dominant justification')
    nodes, edges = layout.get('nodes', {}), layout.get('edges', {})
    require(set(nodes) == {n['id'] for n in graph['nodes']}, 'layout must exactly cover semantic nodes')
    require(set(edges) == {e['id'] for e in graph['edges']}, 'layout must exactly cover semantic edges')
    require(finite(layout.get('fontSize')) and layout['fontSize'] >= 13.34, 'default font must be at least 13.34 px (10 pt)')
    for ident, n in nodes.items():
        require(box(n) and inside(n, diagram), f'{ident}: node must fit diagramFrame')
        require(n.get('glyph') in GLYPHS or nonempty(n.get('customRenderer')), f'{ident}: select a supported glyph or explicit customRenderer')
        require(finite(n.get('fontSize', layout['fontSize'])) and n.get('fontSize', layout['fontSize']) >= 13.34, f'{ident}: label below 10 pt')
    for e in graph['edges']:
        item = edges[e['id']]
        pts = item.get('points', [])
        require(isinstance(pts, list) and len(pts) >= 2 and all(isinstance(p, list) and len(p) == 2 and all(finite(v) for v in p) for p in pts), f'{e["id"]}: needs explicit route')
        require(on_boundary(pts[0], nodes[e['from']]) and on_boundary(pts[-1], nodes[e['to']]), f'{e["id"]}: route is detached from semantic endpoints')
        require(all(0 <= p[0] <= frame['w'] and 0 <= p[1] <= frame['h'] for p in pts), f'{e["id"]}: route leaves canvas')
        for a, b in zip(pts, pts[1:]):
            require(a != b and (a[0] == b[0] or a[1] == b[1]), f'{e["id"]}: fallback routes must be nonzero orthogonal segments')
        require(box(item.get('labelBox')) and inside(item['labelBox'], content), f'{e["id"]}: labelBox must fit the content area')
        require(finite(item.get('fontSize', layout['fontSize'])) and item.get('fontSize', layout['fontSize']) >= 13.34, f'{e["id"]}: edge label below 10 pt')
    return {'canvas': canvas, 'diagramAreaFraction': round(diagram['w']*diagram['h']/(content['w']*content['h']), 3)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('graph')
    p.add_argument('--layout')
    args = p.parse_args()
    try:
        graph = read_json(args.graph)
        result = validate_graph(graph)
        if args.layout:
            result.update(validate_layout(graph, read_json(args.layout)))
        print('PASS: ' + json.dumps(result, ensure_ascii=False))
    except (ValueError, KeyError, TypeError, OSError) as exc:
        p.exit(1, f'ERROR: {exc}\n')


if __name__ == '__main__':
    main()
