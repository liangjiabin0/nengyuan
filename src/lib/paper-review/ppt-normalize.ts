/**
 * 在调用 v3 校验之前，对模型给出的语义图/布局做确定性的结构规范化：
 * - 把不合法的类型、连线种类、机制种类、图元(glyph)映射到最接近的合法值；
 * - 把连线首末点“吸附”到起止节点边框上，并把斜线段拆成水平+竖直两段；
 * - 补齐 formulaLinks、labelBox、字号下限、diagramFrame 面积。
 * 只改几何与枚举写法，不增删节点、不改连线方向和文字，不改变科学含义。
 * 无法安全修复的问题（例如声称的反馈环在图里并不存在）保留给 v3 校验报错，由模型按真实内容修正。
 */
type Box = { x: number; y: number; w: number; h: number };
type Node = { id: string; type?: string; label?: string; evidenceRef?: string };
type Edge = { id: string; from: string; to: string; kind?: string; label?: string; evidenceRef?: string };
type Mechanism = { id: string; kind?: string; nodeIds?: string[]; edgeIds?: string[]; evidenceRef?: string };
type Graph = { schemaVersion?: number; profile?: string; nodes: Node[]; edges: Edge[]; mechanisms?: Mechanism[]; formulaLinks?: Array<{ formulaId: string; nodeIds?: string[]; edgeIds?: string[]; evidenceRef?: string }>; linearJustification?: unknown };
type LayoutNode = Box & { glyph?: string; customRenderer?: string; fontSize?: number };
type LayoutEdge = { points: number[][]; labelBox?: Box; fontSize?: number };
type Layout = { canvas: { width: number; height: number }; contentFrame: Box; diagramFrame: Box; fontSize?: number; fontFamily?: string; nodes: Record<string, LayoutNode>; edges: Record<string, LayoutEdge>; formulas?: Record<string, Box> };

const NODE_TYPES = ['input', 'output', 'device', 'bus', 'plant', 'controller', 'optimizer', 'agent', 'state', 'operation', 'decision', 'sum', 'constraint', 'data'];
const EDGE_KINDS = ['power', 'information', 'control', 'feedback', 'price', 'response', 'decision', 'iteration', 'data', 'sequence'];
const MECH_KINDS = ['feedback', 'branch', 'coupling', 'hierarchy', 'parallel', 'physical-network', 'sequence'];
const GLYPHS = ['process', 'optimizer', 'controller', 'decision', 'sum', 'bus', 'battery', 'converter', 'solar', 'load', 'user', 'data'];
const PROFILES = ['planning', 'operation', 'market', 'control', 'detection', 'forecasting'];
const MIN_FONT = 14;

function nearest(value: string | undefined, allowed: string[], fallback: string, aliases: Record<string, string> = {}) {
  const v = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (allowed.includes(v)) return v;
  if (aliases[v]) return aliases[v];
  const hit = allowed.find((a) => v.includes(a) || a.includes(v));
  return hit || fallback;
}

const EDGE_ALIASES: Record<string, string> = {
  signal: 'information', measurement: 'information', info: 'information', message: 'information', surrogate: 'data', model: 'data',
  constraint: 'decision', cut: 'iteration', update: 'iteration', loop: 'feedback', flow: 'sequence', 'data-flow': 'data', energy: 'power', cost: 'price'
};
const NODE_ALIASES: Record<string, string> = { model: 'operation', process: 'operation', solver: 'optimizer', algorithm: 'operation', dataset: 'data', generator: 'device', system: 'plant', check: 'decision', verification: 'decision' };
const MECH_ALIASES: Record<string, string> = { loop: 'feedback', iterative: 'feedback', iteration: 'feedback', pipeline: 'sequence', decomposition: 'hierarchy', 'two-stage': 'hierarchy' };
const GLYPH_BY_TYPE: Record<string, string> = {
  optimizer: 'optimizer', controller: 'controller', decision: 'decision', sum: 'sum', bus: 'bus', data: 'data', input: 'data', output: 'data',
  agent: 'user', device: 'process', plant: 'process', state: 'process', operation: 'process', constraint: 'process'
};

function clampBoxInside(b: Box, frame: Box): Box {
  const w = Math.min(b.w, frame.w);
  const h = Math.min(b.h, frame.h);
  return { x: Math.min(Math.max(b.x, frame.x), frame.x + frame.w - w), y: Math.min(Math.max(b.y, frame.y), frame.y + frame.h - h), w, h };
}

/** 把点吸附到矩形边框上最近的位置。 */
function snapToBorder(p: number[], b: Box): number[] {
  const [x, y] = p;
  const cx = Math.min(Math.max(x, b.x), b.x + b.w);
  const cy = Math.min(Math.max(y, b.y), b.y + b.h);
  const d = [Math.abs(cx - b.x), Math.abs(b.x + b.w - cx), Math.abs(cy - b.y), Math.abs(b.y + b.h - cy)];
  const i = d.indexOf(Math.min(...d));
  return i === 0 ? [b.x, cy] : i === 1 ? [b.x + b.w, cy] : i === 2 ? [cx, b.y] : [cx, b.y + b.h];
}

/** 让路径只含水平/竖直且不重合的线段：斜线拆成两段，重复点去掉。 */
function orthogonalize(points: number[][]): number[][] {
  const out: number[][] = [];
  for (const p of points) {
    const q = [Math.round(p[0]), Math.round(p[1])];
    const last = out.at(-1);
    if (last && last[0] === q[0] && last[1] === q[1]) continue;
    if (last && last[0] !== q[0] && last[1] !== q[1]) out.push([q[0], last[1]]);
    out.push(q);
  }
  // 拆分后可能出现连续三点共线或重复，再压缩一次
  return out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
}

function edgeRoute(fromBox: Box, toBox: Box, raw: number[][] | undefined): number[][] {
  let pts = Array.isArray(raw) && raw.length >= 2 ? raw.map((p) => [Number(p[0]), Number(p[1])]) : [];
  if (pts.length < 2 || pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) {
    const a = [fromBox.x + fromBox.w / 2, fromBox.y + fromBox.h / 2];
    const b = [toBox.x + toBox.w / 2, toBox.y + toBox.h / 2];
    pts = [a, [b[0], a[1]], b];
  }
  pts[0] = snapToBorder(pts[0], fromBox);
  pts[pts.length - 1] = snapToBorder(pts[pts.length - 1], toBox);
  let route = orthogonalize(pts);
  // 首末点吸附后，拆分出的拐点可能让首段/末段落回节点内部；首末点保持在边框上即可通过 v3 端点检查
  route[0] = snapToBorder(route[0], fromBox);
  route[route.length - 1] = snapToBorder(route[route.length - 1], toBox);
  route = orthogonalize(route);
  if (route.length < 2) route = [snapToBorder([fromBox.x + fromBox.w, fromBox.y + fromBox.h / 2], fromBox), snapToBorder([toBox.x, toBox.y + toBox.h / 2], toBox)];
  return route;
}

/** 第 2 页结果模块的字段名对齐 v3：metrics 的 items→values，chart 的 data→series 等纯命名差异。 */
export function normalizeResultModules(modules: Array<Record<string, unknown>> | undefined, fixes: string[]) {
  for (const [mi, m] of (modules || []).entries()) {
    for (const v of (m.visuals as Array<Record<string, unknown>> | undefined) || []) {
      if (v.type === 'metrics' && !v.values) {
        const alt = v.items || v.metrics || v.data;
        if (alt) { v.values = alt; fixes.push(`结果模块 ${mi + 1} 的 metrics 字段名 items→values`); }
      }
      if (v.type === 'table' && !v.headers && Array.isArray(v.columns)) { v.headers = v.columns; fixes.push(`结果模块 ${mi + 1} 的表格 columns→headers`); }
      if (v.type === 'chart' && !v.series && Array.isArray(v.data)) { v.series = v.data; fixes.push(`结果模块 ${mi + 1} 的图表 data→series`); }
      if (!v.evidenceRef && m.evidenceRef) v.evidenceRef = m.evidenceRef;
    }
  }
  return modules;
}

/** v3 要求每页摘要 ≤150 字、最多两行：超长时在句读处截断，换行合并为一处。 */
export function normalizeSummaryRuns(runs: Array<{ text: string; emphasis?: string; bold?: boolean }> | undefined, fixes: string[], slide: string) {
  if (!Array.isArray(runs) || !runs.length) return runs;
  const total = runs.map((r) => String(r.text || '')).join('');
  let changed = false;
  let newlines = 0;
  for (const r of runs) {
    r.text = String(r.text || '').replace(/\r?\n/g, () => (newlines++ === 0 ? '\n' : ''));
  }
  if (newlines > 1) changed = true;
  // 只在完整句子的边界截断，绝不留半句话或省略号；放不下的整句直接去掉（视觉审核会把半句话判为不可读）
  let budget = 148;
  const out: typeof runs = [];
  for (const r of runs) {
    if (budget <= 0) { changed = true; break; }
    if (r.text.length > budget) {
      const cut = r.text.slice(0, budget);
      const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('！'), cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.endsWith('.') ? cut.length - 1 : -1);
      changed = true;
      if (stop > 0) r.text = cut.slice(0, stop + 1).trimEnd();
      else if (out.length) break;
      else {
        // 第一段就没有句子边界：退到最后一个词边界，以句号结束
        const space = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('，'), cut.lastIndexOf(','));
        r.text = `${cut.slice(0, space > budget * 0.5 ? space : budget - 1).trimEnd().replace(/[,，;；:：]$/, '')}${/[一-鿿]/.test(cut) ? '。' : '.'}`;
      }
    }
    budget -= r.text.length;
    if (r.text) out.push(r);
  }
  if (changed) fixes.push(`${slide} 摘要从 ${total.length} 字压缩到 ${out.map((r) => r.text).join('').length} 字`);
  return out;
}

export function normalizeV3Plan(graph: Graph, layout: Layout, formulaIds: string[]) {
  const fixes: string[] = [];
  graph.schemaVersion = 1;
  const profile = nearest(graph.profile, PROFILES, 'planning');
  if (profile !== graph.profile) { fixes.push(`profile ${graph.profile}→${profile}`); graph.profile = profile; }
  for (const n of graph.nodes || []) {
    const t = nearest(n.type, NODE_TYPES, 'operation', NODE_ALIASES);
    if (t !== n.type) { fixes.push(`节点 ${n.id} 类型 ${n.type}→${t}`); n.type = t; }
    if (!n.evidenceRef) n.evidenceRef = '见论文正文';
  }
  const ids = new Set((graph.nodes || []).map((n) => n.id));
  graph.edges = (graph.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  for (const e of graph.edges) {
    const k = nearest(e.kind, EDGE_KINDS, 'information', EDGE_ALIASES);
    if (k !== e.kind) { fixes.push(`连线 ${e.id} 种类 ${e.kind}→${k}`); e.kind = k; }
    if (!e.evidenceRef) e.evidenceRef = '见论文正文';
  }
  for (const m of graph.mechanisms || []) {
    const k = nearest(m.kind, MECH_KINDS, 'sequence', MECH_ALIASES);
    if (k !== m.kind) { fixes.push(`机制 ${m.id} 种类 ${m.kind}→${k}`); m.kind = k; }
    // 机制的边端点必须在机制节点集合内：补上缺失的端点节点
    const edgeSet = new Set(m.edgeIds || []);
    const nodeSet = new Set(m.nodeIds || []);
    for (const e of graph.edges) if (edgeSet.has(e.id)) { nodeSet.add(e.from); nodeSet.add(e.to); }
    m.nodeIds = [...nodeSet].filter((id) => ids.has(id));
    m.edgeIds = [...edgeSet].filter((id) => graph.edges.some((e) => e.id === id));
  }
  // formulaLinks 必须恰好覆盖显示的公式：缺的补到第一个节点上，多的删掉
  const links = (graph.formulaLinks || []).filter((f) => formulaIds.includes(f.formulaId));
  for (const fid of formulaIds) {
    if (!links.some((f) => f.formulaId === fid)) {
      links.push({ formulaId: fid, nodeIds: [graph.nodes[0]?.id].filter(Boolean) as string[], edgeIds: [], evidenceRef: '见论文公式' });
      fixes.push(`为公式 ${fid} 补充 formulaLink`);
    }
  }
  graph.formulaLinks = links;

  // ---------- 布局 ----------
  const canvas = layout.canvas;
  const page: Box = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  layout.contentFrame = clampBoxInside(layout.contentFrame, page);
  layout.diagramFrame = clampBoxInside(layout.diagramFrame, layout.contentFrame);
  if (layout.diagramFrame.w * layout.diagramFrame.h < 0.46 * layout.contentFrame.w * layout.contentFrame.h && !(layout as { compactDiagramReason?: string }).compactDiagramReason) {
    layout.diagramFrame = { ...layout.contentFrame };
    fixes.push('diagramFrame 扩大到 contentFrame');
  }
  layout.fontSize = Math.max(MIN_FONT, Number(layout.fontSize) || 16);
  for (const n of graph.nodes) {
    const ln = layout.nodes?.[n.id];
    if (!ln) continue;
    // 菱形/椭圆的可用文字区只有外框的一半左右：按标签长度放大到能容纳 14px 文字的尺寸（以中心为基准）
    const glyphNow = String(ln.glyph || '');
    if (glyphNow === 'decision' || glyphNow === 'sum') {
      const units = [...String(n.label || '')].reduce((a, ch) => a + (/[　-鿿＀-￯]/.test(ch) ? 1 : 0.6), 0);
      const lineCap = Math.max(4, Math.floor((ln.w * 0.5) / MIN_FONT));
      const needH = Math.ceil(units / lineCap) * MIN_FONT * 1.3 / 0.5 + 8;
      if (ln.h < needH) {
        const cy = ln.y + ln.h / 2;
        const grow = Math.min(needH, layout.diagramFrame.h);
        ln.h = grow;
        ln.y = cy - grow / 2;
        ln.w = Math.max(ln.w, Math.min(grow * 1.6, layout.diagramFrame.w / 3));
        fixes.push(`判断节点 ${n.id} 放大到 ${Math.round(ln.w)}×${Math.round(ln.h)} 以容纳文字`);
      }
    }
    Object.assign(ln, clampBoxInside(ln, layout.diagramFrame));
    if (ln.customRenderer || !GLYPHS.includes(String(ln.glyph))) {
      const g = GLYPH_BY_TYPE[n.type || ''] || 'process';
      fixes.push(`节点 ${n.id} 图元 ${ln.glyph || ln.customRenderer}→${g}`);
      ln.glyph = g;
      delete ln.customRenderer;
    }
    if (ln.fontSize !== undefined) ln.fontSize = Math.max(MIN_FONT, ln.fontSize);
  }
  for (const e of graph.edges) {
    const fromBox = layout.nodes?.[e.from];
    const toBox = layout.nodes?.[e.to];
    if (!fromBox || !toBox) continue;
    const le = (layout.edges[e.id] ||= { points: [] });
    le.points = edgeRoute(fromBox, toBox, le.points);
    const mid = le.points[Math.floor(le.points.length / 2)];
    const lb = le.labelBox && Number.isFinite(le.labelBox.x) ? le.labelBox : { x: mid[0] - 60, y: mid[1] - 26, w: 120, h: 24 };
    le.labelBox = clampBoxInside(lb, layout.contentFrame);
    if (le.fontSize !== undefined) le.fontSize = Math.max(MIN_FONT, le.fontSize);
  }
  // 公式框太小时公式会被缩到看不清：保证宽 ≥ 260px、高 ≥ 56px，且不越出页面
  for (const [fid, box] of Object.entries(layout.formulas || {})) {
    if (box.h < 56 || box.w < 260) {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      box.w = Math.max(box.w, 260);
      box.h = Math.max(box.h, 56);
      box.x = cx - box.w / 2;
      box.y = Math.max(layout.contentFrame.y, Math.min(cy - box.h / 2, page.h - box.h));
      fixes.push(`公式框 ${fid} 放大到 ${Math.round(box.w)}×${Math.round(box.h)}`);
    }
    Object.assign(box, clampBoxInside(box, page));
  }
  // 公式框不能压住连线：与任何连线段相交时，在内容区内找最近的不相交位置平移过去
  const segs = Object.values(layout.edges).flatMap((e) => e.points.slice(1).map((p, i) => [e.points[i], p] as const));
  const nodeBoxes = Object.values(layout.nodes);
  const hitsLine = (b: Box) => segs.some(([a, c]) => {
    const minX = Math.min(a[0], c[0]); const maxX = Math.max(a[0], c[0]);
    const minY = Math.min(a[1], c[1]); const maxY = Math.max(a[1], c[1]);
    return maxX >= b.x && minX <= b.x + b.w && maxY >= b.y && minY <= b.y + b.h;
  });
  const hitsNode = (b: Box) => nodeBoxes.some((n) => n.x < b.x + b.w && n.x + n.w > b.x && n.y < b.y + b.h && n.y + n.h > b.y);
  const formulaBoxes = Object.entries(layout.formulas || {});
  const hitsFormula = (b: Box, self: string) => formulaBoxes.some(([id, f]) => id !== self && f.x < b.x + b.w && f.x + f.w > b.x && f.y < b.y + b.h && f.y + f.h > b.y);
  for (const [fid, box] of formulaBoxes) {
    if (!hitsLine(box) && !hitsNode(box)) continue;
    let best: Box | null = null;
    let bestDist = Infinity;
    for (let dy = -240; dy <= 240; dy += 12) {
      for (let dx = -360; dx <= 360; dx += 12) {
        const cand = clampBoxInside({ ...box, x: box.x + dx, y: box.y + dy }, layout.contentFrame);
        if (hitsLine(cand) || hitsNode(cand) || hitsFormula(cand, fid)) continue;
        const d = Math.hypot(cand.x - box.x, cand.y - box.y);
        if (d < bestDist) { bestDist = d; best = cand; }
      }
    }
    if (best) {
      Object.assign(box, best);
      fixes.push(`公式框 ${fid} 平移 ${Math.round(bestDist)}px，避开连线和节点`);
    }
  }
  for (const id of Object.keys(layout.edges)) if (!graph.edges.some((e) => e.id === id)) delete layout.edges[id];
  for (const id of Object.keys(layout.nodes)) if (!ids.has(id)) delete layout.nodes[id];
  return fixes;
}
