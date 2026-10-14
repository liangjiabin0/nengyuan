// 冒烟测试：用 v3 技能自带的 draw_semantic_diagram.mjs（不修改）在能元 PptxGenJS 适配层上
// 画出 bidirectional-overload 案例的方法图，再加一个原生图表和表格，导出 2 页 PPTX，
// 然后跑 v3 的 Python 校验（可见性 / 模板绑定 / 坐标轴）。
//   node scripts/paper-review/test-v3-adapter.mjs [输出目录]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile, applyPresentationChartFont } from '../../tools/ppt-native/v3-adapter/presentation.mjs';
import { resolvePaperReviewPython } from './runtime.mjs';

const ROOT = process.cwd();
const SKILL = path.join(ROOT, '.opencode', 'skills', 'two-slide-paper-ppt-graphical-v3');
const CASE = path.join(SKILL, 'assets', 'cases', 'bidirectional-overload', 'reference-data');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'storage', 'paper-review', 'selftest'));
await fs.mkdir(out, { recursive: true });

const { drawSemanticDiagram } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'draw_semantic_diagram.mjs')).href);
const graph = JSON.parse(await fs.readFile(path.join(CASE, 'semantic-graph.json'), 'utf8'));
const layout = JSON.parse(await fs.readFile(path.join(CASE, 'diagram-layout.json'), 'utf8'));
const W = layout.slideSize?.width || 1672;
const H = layout.slideSize?.height || 941;

const presentation = Presentation.create({ slideSize: { width: W, height: H } });
const s1 = presentation.slides.add();
const title = s1.shapes.add({ name: 'slide-title', geometry: 'textbox', position: { left: 20, top: 0, width: W - 40, height: 64 }, fill: 'none', line: {} });
title.text = '适配层自检：语义机制图';
title.text.style = { typeface: 'Microsoft YaHei', fontSize: 28, bold: true, color: '#07368C' };
const coverage = drawSemanticDiagram(s1, graph, layout);
s1.speakerNotes.textFrame.setText('自检：v3 draw_semantic_diagram.mjs 未修改，运行在能元 PptxGenJS 适配层上。');

const s2 = presentation.slides.add();
const t2 = s2.shapes.add({ name: 'slide-title', geometry: 'textbox', position: { left: 20, top: 0, width: W - 40, height: 64 }, fill: 'none', line: {} });
t2.text = '适配层自检：原生图表与表格';
t2.text.style = { typeface: 'Microsoft YaHei', fontSize: 28, bold: true, color: '#07368C' };
const chart = s2.charts.add('line', {
  position: { left: 40, top: 120, width: 760, height: 420 },
  categories: ['1', '2', '3', '4', '5'],
  series: [
    { name: '本文方法', values: [1.2, 1.0, 0.9, 0.85, 0.8], line: { fill: '#004BA0', width: 3.2, style: 'solid' }, marker: { symbol: 'circle', size: 8 } },
    { name: '基线', values: [1.4, 1.3, 1.25, 1.2, 1.18], line: { fill: '#C00000', width: 2.4, style: 'dashed' }, marker: { symbol: 'diamond', size: 6 } }
  ],
  hasLegend: true,
  legend: { position: 'top', textStyle: { typeface: 'Microsoft YaHei', fontSize: 14 } },
  xAxis: { title: { text: '迭代次数', textStyle: { fontSize: 16 } }, textStyle: { fontSize: 14 }, line: { fill: '#595959', width: 1.5 }, majorGridlines: { style: 'dashed', fill: '#A6A6A6', width: 1.1 } },
  yAxis: { title: { text: '误差', textStyle: { fontSize: 16 } }, min: 0.6, max: 1.6, majorUnit: 0.2, numberFormatCode: '0.0', textStyle: { fontSize: 14 }, line: { fill: '#595959', width: 1.5 }, majorGridlines: { style: 'dashed', fill: '#A6A6A6', width: 1.1 } },
  plotAreaFill: '#FFFFFF',
  plotAreaLine: { fill: '#595959', width: 1.5 }
});
applyPresentationChartFont(chart, { fontFamily: 'Microsoft YaHei' });
const table = s2.tables.add({ rows: 3, columns: 3, left: 860, top: 140, width: 760, height: 220, values: [['指标', '本文', '基线'], ['误差', '0.80', '1.18'], ['耗时/s', '12', '9']] });
table.borders.assign({ style: 'solid', fill: '#8EBCCB', width: 0.8 });
for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) {
  const cell = table.getCell(r, c);
  cell.fill = r === 0 ? '#0B438C' : '#FFFFFF';
  cell.text.style = { typeface: 'Microsoft YaHei', fontSize: 14, bold: r === 0, color: r === 0 ? '#FFFFFF' : '#172A3A', alignment: 'center' };
}

const pptxPath = path.join(out, 'adapter-selftest.pptx');
await (await PresentationFile.exportPptx(presentation, { title: '适配层自检' })).save(pptxPath);
await fs.writeFile(path.join(out, 'diagram-coverage.json'), JSON.stringify(coverage, null, 2));

const python = resolvePaperReviewPython();
const run = (script, args) => {
  try {
    const output = execFileSync(python, [path.join(SKILL, 'scripts', script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { script, ok: true, output: output.trim().slice(-600) };
  } catch (error) {
    return { script, ok: false, output: String(error.stdout || '') + String(error.stderr || error.message) };
  }
};
const checks = [
  run('validate_semantic_graph.py', [path.join(CASE, 'semantic-graph.json'), '--layout', path.join(CASE, 'diagram-layout.json')]),
  run('audit_visible_pptx.py', [pptxPath]),
  run('audit_template_bindings.py', [pptxPath]),
  run('audit_plot_axes.py', [pptxPath])
];
const nodeCount = Object.keys(coverage.nodes).length;
const edgeCount = Object.keys(coverage.edges).length;
console.log(JSON.stringify({ pptxPath, nodes: nodeCount, edges: edgeCount, checks }, null, 2));
if (checks.some((c) => !c.ok)) process.exitCode = 1;
