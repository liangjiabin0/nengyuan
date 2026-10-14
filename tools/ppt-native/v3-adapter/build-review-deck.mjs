// 论文智能评审的两页 PPT 构建器（v3 graphical 规则 + 能元 PptxGenJS 适配层）。
//
// 输入：已通过 v3 validate_two_slide_spec.py 的 spec.json（slide2 使用 resultModules，恰好三个主题）。
// 第 1 页：直接调用 v3 技能自带、未修改的 draw_semantic_diagram.mjs 画原生可编辑机制图，公式用离线 MathJax 生成 SVG。
// 第 2 页：三个证据主题，chart / table / metrics 均为原生对象；没有可靠数值时用阻碍表，不画虚构曲线。
// 输出：final PPTX、diagram-coverage.json、formula-manifest.json、build-receipt.json。
//
//   node tools/ppt-native/v3-adapter/build-review-deck.mjs --spec <spec.json> --out <deck.pptx> --skill <v3 技能目录> --work <构建目录>
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile, applyPresentationChartFont } from './presentation.mjs';
import { renderLatexSvg } from '../math-svg.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SPEC_PATH = path.resolve(arg('spec') || '');
const OUT = path.resolve(arg('out') || '');
const SKILL = path.resolve(arg('skill') || '');
const WORK = path.resolve(arg('work') || path.dirname(OUT));
if (!arg('spec') || !arg('out') || !arg('skill')) {
  console.error('用法：build-review-deck.mjs --spec <spec.json> --out <deck.pptx> --skill <v3 技能目录> [--work <构建目录>]');
  process.exit(2);
}

const spec = JSON.parse(await fs.readFile(SPEC_PATH, 'utf8'));
const resolveSpec = (p) => (path.isAbsolute(p) ? p : path.resolve(path.dirname(SPEC_PATH), p));
const { drawSemanticDiagram } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'draw_semantic_diagram.mjs')).href);

const graph = JSON.parse(await fs.readFile(resolveSpec(spec.slide1.semanticGraphPath), 'utf8'));
const layout = JSON.parse(await fs.readFile(resolveSpec(spec.slide1.diagramLayoutPath), 'utf8'));
const W = spec.meta.slideSize?.width || layout.canvas?.width || 1280;
const H = spec.meta.slideSize?.height || layout.canvas?.height || 720;
const FONT = spec.meta.fontFamily || layout.fontFamily || 'Microsoft YaHei';
const C = {
  navy: '#0B438C', teal: '#169C98', red: '#C62828', ink: '#172A3A', gray: '#586B78',
  pale: '#EEF7FA', paleBlue: '#DCEEF8', paleTeal: '#E5F6F3', border: '#8EBCCB', grid: '#A6A6A6', white: '#FFFFFF'
};
const sx = W / 1280;
const sy = H / 720;

const presentation = Presentation.create({ slideSize: { width: W, height: H } });

function addShape(slide, name, geometry, x, y, width, height, fill = 'none', lineFill = 'none', lineWidth = 0, radius = 0, lineStyle = 'solid') {
  return slide.shapes.add({ geometry, name, position: { left: x, top: y, width, height }, fill, line: { style: lineStyle, fill: lineFill, width: lineWidth }, ...(radius ? { borderRadius: radius } : {}) });
}

function addText(slide, name, value, x, y, width, height, style = {}, fill = 'none', lineFill = 'none', lineWidth = 0, radius = 0) {
  const box = addShape(slide, name, radius ? 'roundRect' : 'textbox', x, y, width, height, fill, lineFill, lineWidth, radius);
  box.text = value;
  box.text.style = { typeface: FONT, fontSize: 14, color: C.ink, autoFit: 'shrinkText', wrap: 'square', alignment: 'left', verticalAlignment: 'middle', insets: { left: 6, right: 6, top: 3, bottom: 3 }, ...style };
  return box;
}

/**
 * 标题 + 两行摘要。bottom 为页眉下沿（像素）：第 1 页贴合 diagram-layout.json 的 contentFrame.y，
 * 第 2 页用默认值。页眉最少 150px（按 720 高换算），保证 28pt 标题和两行 16pt 摘要放得下。
 */
function addChrome(slide, title, summaryRuns, bottom = 196 * sy) {
  slide.background.fill = C.white;
  // 标题字号按长度递减，保证一行放下（v3 字号阶梯 28→24→20→18pt）；标题框高度给足一行，分隔线放在框下方。
  const titleLen = [...String(title)].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
  const titleSize = titleLen <= 70 ? 28 : titleLen <= 90 ? 24 : titleLen <= 115 ? 20 : 18;
  const titleH = Math.max(titleSize * 1.55 * sy, Math.min(52 * sy, (bottom - 16 * sy) * 0.32));
  const ruleY = 12 * sy + titleH + 4 * sy;
  const boxY = ruleY + 10 * sy;
  const boxH = Math.max(40 * sy, bottom - boxY - 8 * sy);
  addText(slide, 'slide-title', title, 34 * sx, 12 * sy, W - 68 * sx, titleH, { fontSize: titleSize, bold: true, color: C.navy, wrap: 'none', insets: { left: 0, right: 0, top: 0, bottom: 0 } });
  addShape(slide, 'title-rule', 'rect', 0, ruleY, W, 4 * sy, C.navy);
  addShape(slide, 'summary-box', 'roundRect', 30 * sx, boxY, W - 60 * sx, boxH, C.white, C.teal, 1.4, 8);
  const summary = addText(slide, 'summary-text', '', 50 * sx, boxY + 4 * sy, W - 100 * sx, boxH - 8 * sy, { fontSize: 16, bold: true });
  // 相邻两段之间若都是西文且没有空白，补一个空格（例如 “nadir.” 与 “The …” 之间）
  const runs = summaryRuns.map((run, i) => {
    const prev = summaryRuns[i - 1]?.text || '';
    const needSpace = i > 0 && /[A-Za-z0-9.,;:)]$/.test(prev) && /^[A-Za-z0-9(]/.test(run.text || '');
    return { ...run, text: needSpace ? ` ${run.text}` : run.text };
  });
  summary.text.set([{ runs: runs.map((run) => ({ run: run.text, textStyle: { typeface: FONT, fontSize: '16pt', bold: run.bold ?? true, color: run.emphasis === 'red' ? C.red : C.ink } })) }]);
}

// ---------- 第 1 页 ----------
const formulaPlacements = [];
const formulaDir = path.join(WORK, 'formula-svg');
await fs.mkdir(formulaDir, { recursive: true });

function containInBox(svg, box) {
  const vb = svg.match(/viewBox=["']([^"']+)["']/i)?.[1]?.trim().split(/\s+/).map(Number);
  if (!vb || vb.length !== 4 || !vb.every(Number.isFinite)) return box;
  const aspect = vb[2] / vb[3];
  let width, height;
  if (aspect > box.width / box.height) { width = box.width; height = width / aspect; } else { height = box.height; width = height * aspect; }
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/**
 * v3 draw_semantic_diagram.mjs 给 optimizer 节点画了两条距边框 8px 的竖线、给 controller/data 节点画了横线，
 * 但文字框只留 3px 内边距，长标签会压到线上。不改 v3 脚本，只在画完后把这些节点文字的内边距加大到避开装饰线。
 */
function padDecoratedLabels(slide, layoutNodes) {
  for (const obj of slide.objects) {
    const m = /^dg-node-(.+)-label-1$/.exec(obj.name || '');
    if (!m || !obj.text) continue;
    const node = layoutNodes[m[1]] || {};
    const glyph = node.glyph;
    const pad = node.textPadding || {};
    const ins = { ...(obj.text.style.insets || {}) };
    // 竖线在距边框 8px 处、线宽 3px：文字至少离边框 20px，才和竖线之间留出明显空白；layout 给了更大的 textPadding 时照用
    if (glyph === 'optimizer') { ins.left = Math.max(20, pad.left || 0); ins.right = Math.max(20, pad.right || 0); }
    if (glyph === 'controller' || glyph === 'data') { ins.top = Math.max(10, pad.top || 0); ins.bottom = Math.max(10, pad.bottom || 0); }
    obj.text.style = { ...obj.text.style, insets: ins };
  }
}

const s1 = presentation.slides.add();
const headerBottom = layout.contentFrame?.y ?? 0;
if (headerBottom < 150 * sy) throw new Error(`diagram-layout.json 的 contentFrame.y 必须 ≥ ${Math.ceil(150 * sy)}，给标题和两行摘要留出空间`);
addChrome(s1, spec.slide1.title, spec.slide1.summaryRuns, headerBottom - 8 * sy);
const coverage = drawSemanticDiagram(s1, graph, layout);
padDecoratedLabels(s1, layout.nodes);
for (const formula of spec.slide1.formulas || []) {
  const box = layout.formulas?.[formula.id];
  if (!box || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(box[k]))) throw new Error(`公式 ${formula.id} 需要在 diagram-layout.json.formulas 中给出相邻位置`);
  const svg = (await renderLatexSvg({ latex: formula.latex, color: C.navy })).replace(/(<svg\b[^>]*>)/i, `$1<metadata>${JSON.stringify({ id: formula.id, latex: formula.latex }).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</metadata>`);
  await fs.writeFile(path.join(formulaDir, `${formula.id}.svg`), svg, 'utf8');
  addShape(s1, `formula-frame-${formula.id}`, 'roundRect', box.x, box.y, box.w, box.h, '#F9FCFD', C.border, 0.8, 6);
  const name = `latex-svg-${formula.id}`;
  s1.images.add({ name, blob: new TextEncoder().encode(svg), contentType: 'image/svg+xml', alt: `LaTeX: ${formula.latex}`, position: containInBox(svg, { left: box.x + 6, top: box.y + 4, width: box.w - 12, height: box.h - 8 }) });
  formulaPlacements.push({ ...formula, slide: 1, targetShapeName: name, position: box });
}
s1.speakerNotes.textFrame.setText(spec.slide1.notes || `方法证据：${(spec.slide1.panels || []).map((p) => p.evidenceRef).join('；')}。公式证据：${(spec.slide1.formulas || []).map((f) => f.evidenceRef).join('；')}。`);

// ---------- 第 2 页 ----------
const ORIGIN_LABEL = {
  principle_reproduction: '审稿人原理级复现',
  simulated_reproduction: '审稿人模拟复现',
  partial_reproduction: '审稿人部分复现',
  paper_reported_context: '论文报告值（背景参照）',
  reproduction_barrier: '复现阻碍'
};

const baseline = [
  { color: '#C00000', width: 2.4, style: 'dashed', marker: 'diamond' },
  { color: '#007A33', width: 2.4, style: 'dash-dot', marker: 'square' },
  { color: '#604A7B', width: 2.4, style: 'dotted', marker: 'triangle' }
];

/**
 * 表格单元格原样显示 spec 给出的数值文本：数值精度属于证据内容，构建器不擅自舍入。
 * 只对明显是浮点误差的超长尾数（≥10 位小数，如 126.54400000000001）做清理，按 10 位有效数字去掉尾差。
 */
function formatCell(value) {
  const s = String(value ?? '');
  if (/^-?\d+\.\d{10,}$/.test(s)) return String(Number(Number(s).toPrecision(10)));
  return s;
}

/** 按每列最长文字估算列宽（中文按 2 个字符宽），总宽保持不变。 */
function columnWidths(values, totalWidth) {
  const len = (t) => [...String(t)].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
  const cols = values[0].length;
  // 表头单词与数值不宜拆行：取“最长不可断片段”（单词/数字）作为每列的最小需求，再按整体文字量分配剩余宽度。
  const longestToken = (t) => Math.max(1, ...String(t).split(/[\s/]+/).map(len));
  const minNeed = Array.from({ length: cols }, (_, c) => Math.max(3, ...values.map((r) => longestToken(r[c] ?? ''))));
  const softNeed = Array.from({ length: cols }, (_, c) => Math.max(minNeed[c], ...values.map((r) => Math.min(24, len(r[c] ?? '')))));
  const charW = totalWidth / Math.max(1, softNeed.reduce((a, b) => a + b, 0));
  const minTotal = minNeed.reduce((a, b) => a + b, 0) * 1.15;
  // 能放下就按软需求分配；最小需求都放不下时按最小需求比例分配（文字会缩小，但单词不再被截断）
  const base = minTotal * charW > totalWidth ? minNeed : softNeed;
  const sum = base.reduce((a, b) => a + b, 0);
  return base.map((n) => (n / sum) * totalWidth);
}

function chart(slide, v, frame, name) {
  const focus = v.focusSeries || v.series.at(-1)?.name;
  const series = v.series.map((s, i) => {
    const p = s.name === focus ? { color: '#004BA0', width: 3.2, style: 'solid', marker: 'circle' } : baseline[i % baseline.length];
    return { name: s.name, values: s.values, line: { style: p.style, fill: p.color, width: p.width }, marker: { symbol: p.marker, size: s.name === focus ? 8 : 6 } };
  });
  const axis = (title) => ({ title: { text: title, textStyle: { typeface: FONT, fontSize: 12 } }, textStyle: { typeface: FONT, fontSize: 10 }, line: { style: 'solid', fill: '#595959', width: 1.2 }, majorGridlines: { style: 'dashed', fill: C.grid, width: 1 } });
  const c = slide.charts.add(v.chartType === 'bar' ? 'bar' : 'line', {
    name, position: frame, categories: v.categories, series, hasLegend: true,
    legend: { position: 'top', textStyle: { typeface: FONT, fontSize: 10 } },
    xAxis: axis(v.xTitle),
    yAxis: { ...axis(v.yTitle), min: v.yMin, max: v.yMax, majorUnit: v.yMajorUnit, numberFormatCode: v.numberFormatCode || 'General' },
    plotAreaFill: C.white, plotAreaLine: { style: 'solid', fill: '#595959', width: 1.2 }
  });
  applyPresentationChartFont(c, { fontFamily: FONT });
}

function table(slide, v, frame) {
  const values = [v.headers, ...v.rows].map((r) => r.map(formatCell));
  // 字号：按“每列最长不可断片段之和”能否放进栏宽来选 11pt 或 10pt（v3 下限 10pt）
  const tokenLen = (t) => Math.max(1, ...String(t).split(/[\s/]+/).map((w) => [...w].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0)));
  const need = values[0].map((_, c) => Math.max(...values.map((r) => tokenLen(r[c] ?? '')))).reduce((a, b) => a + b, 0);
  const size = need * 7.4 * sx > frame.width ? 10 : 11;
  const height = Math.min(frame.height, 30 * sy * values.length + 10);
  const t = slide.tables.add({ rows: values.length, columns: v.headers.length, left: frame.left, top: frame.top, width: frame.width, height, values });
  t.columnWidths = columnWidths(values, frame.width);
  t.borders.assign({ style: 'solid', fill: C.border, width: 0.8 });
  for (let r = 0; r < values.length; r += 1) for (let c = 0; c < v.headers.length; c += 1) {
    const cell = t.getCell(r, c);
    cell.fill = r === 0 ? C.navy : r % 2 ? C.white : C.pale;
    cell.text.style = { typeface: FONT, fontSize: r === 0 ? size + 1 : size, bold: r === 0, color: r === 0 ? C.white : C.ink, alignment: 'center', verticalAlignment: 'middle', insets: { left: 2, right: 2, top: 1, bottom: 1 } };
  }
}

function metrics(slide, v, frame, id) {
  const items = Array.isArray(v.values) ? v.values : Object.entries(v.values || {}).map(([label, value]) => ({ label, value }));
  const h = Math.min(56 * sy, frame.height / Math.max(1, items.length));
  items.forEach((m, i) => {
    addText(slide, `${id}-metric-${i}`, `${m.label}：${m.value}${m.unit ? ` ${m.unit}` : ''}`, frame.left, frame.top + i * h, frame.width, h - 6 * sy, { fontSize: 12, bold: i === 0, color: C.navy, alignment: 'left' }, C.pale, C.border, 0.6, 5);
  });
}

const s2 = presentation.slides.add();
addChrome(s2, spec.slide2.title, spec.slide2.summaryRuns);
const modules = spec.slide2.resultModules;
if (!Array.isArray(modules) || modules.length !== 3) throw new Error('第 2 页需要恰好三个 resultModules');
const panelW = (W - 60 * sx - 2 * 18 * sx) / 3;
const top = 206 * sy;
const panelH = H - top - 16 * sy;
modules.forEach((m, mi) => {
  const x = 30 * sx + mi * (panelW + 18 * sx);
  const id = `s2-m${mi + 1}`;
  addShape(s2, `${id}-outline`, 'roundRect', x, top, panelW, panelH, C.white, C.border, 1.2, 8, 'dashed');
  addText(s2, `${id}-header`, m.title, x + 30 * sx, top + 4 * sy, panelW - 60 * sx, 34 * sy, { fontSize: 14, bold: true, color: C.navy, alignment: 'center' }, C.paleBlue, 'none', 0, 7);
  // 结论框高度按文字量估算（12pt 约每行 panelW/9 个西文字符），文字放在框内并启用缩字，避免越出背景框和栏目边界。
  const cLen = [...String(m.conclusion || '')].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
  const perLine = Math.max(20, Math.floor((panelW - 24 * sx) / (7.2 * sx)));
  const lines = Math.min(5, Math.max(2, Math.ceil(cLen / perLine)));
  const cH = (lines * 17 + 12) * sy;
  addText(s2, `${id}-conclusion`, m.conclusion, x + 6 * sx, top + panelH - cH - 6 * sy, panelW - 12 * sx, cH, { fontSize: 12, bold: true, color: C.navy, alignment: 'center', autoFit: 'shrinkText' }, C.paleTeal, 'none', 0, 6);
  // 数据性质标签（审稿人复现 / 论文报告 / 复现阻碍）必须在版面上可见，不能只写在备注里。
  // 模型产出的 spec 有 dataOrigin 和 data_origin 两种写法；spec 给了 dataOriginLabel 时原样显示，否则按枚举翻译。
  const origin = m.dataOrigin || m.data_origin || m.visuals?.map((v) => v.dataOrigin || v.data_origin).find(Boolean);
  const badge = m.dataOriginLabel || ORIGIN_LABEL[origin] || '';
  let areaTop = top + 46 * sy;
  if (badge) {
    addText(s2, `${id}-origin-badge`, badge, x + 10 * sx, areaTop - 4 * sy, panelW - 20 * sx, 22 * sy, { fontSize: 11, bold: true, color: C.teal, alignment: 'center', autoFit: 'shrinkText' }, C.white, C.teal, 0.8, 5);
    areaTop += 24 * sy;
  }
  const areaH = top + panelH - cH - 16 * sy - areaTop;
  const visuals = m.visuals || [];
  const each = areaH / Math.max(1, visuals.length);
  visuals.forEach((v, vi) => {
    // 单位说明放在所属图表正下方，占用该图表区域底部一行
    const noteH = v.unitNote ? 20 * sy : 0;
    const frame = { left: x + 10 * sx, top: areaTop + vi * each, width: panelW - 20 * sx, height: each - 6 * sy - noteH };
    if (v.unitNote) addText(s2, `${id}-v${vi + 1}-unit-note`, v.unitNote, frame.left, frame.top + frame.height + 2 * sy, frame.width, noteH - 2 * sy, { fontSize: 10, color: C.gray, alignment: 'center', autoFit: 'shrinkText' });
    if (v.type === 'chart') chart(s2, v, frame, `${id}-chart-${vi + 1}`);
    else if (v.type === 'table') table(s2, v, frame);
    else if (v.type === 'metrics') metrics(s2, v, frame, `${id}-v${vi + 1}`);
    else if (v.type === 'diagram') addText(s2, `${id}-diagram-${vi + 1}`, v.description, frame.left, frame.top, frame.width, frame.height, { fontSize: 12, alignment: 'center' }, C.pale, C.border, 0.8, 6);
    else throw new Error(`第 2 页暂不支持的可视化类型：${v.type}（source-figure 需要源图裁剪，评审流程不使用）`);
  });
});
s2.speakerNotes.textFrame.setText(spec.slide2.notes || `结果证据：${modules.map((m) => `${m.title}（${m.evidenceRef}）`).join('；')}。`);

// ---------- 导出 ----------
await fs.mkdir(path.dirname(OUT), { recursive: true });
await (await PresentationFile.exportPptx(presentation, { title: spec.meta.paperTitle || '' })).save(OUT);
const sha = async (p) => crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex');
await fs.writeFile(path.join(WORK, 'diagram-coverage.json'), JSON.stringify(coverage, null, 2));
await fs.writeFile(path.join(WORK, 'formula-manifest.json'), JSON.stringify({ sourcePptx: OUT, formulas: formulaPlacements }, null, 2));
const receipt = {
  builder: 'tools/ppt-native/v3-adapter/build-review-deck.mjs',
  diagramRenderer: 'v3 scripts/draw_semantic_diagram.mjs (unmodified)',
  formulaRenderer: 'tools/ppt-native/math-svg.mjs (mathjax-full, offline)',
  slides: 2,
  pptx: OUT,
  pptxSha256: await sha(OUT),
  nativeDiagramObjects: Object.values(coverage.nodes).flat().length + Object.values(coverage.edges).flat().length,
  formulas: formulaPlacements.length
};
await fs.writeFile(path.join(WORK, 'build-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
