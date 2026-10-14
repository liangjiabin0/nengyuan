import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { renderLatexSvg } from "./render_latex_svg.mjs";
import { drawSemanticDiagram } from "./draw_semantic_diagram.mjs";

const {
  SPEC_PATH,
  FINAL_PPTX,
  TMP_DIR,
  WORKSPACE_DIR,
  PRESENTATIONS_SKILL_DIR,
  RUNTIME_NODE_MODULES,
  RUNTIME_PYTHON,
} = process.env;

for (const [key, value] of Object.entries({ SPEC_PATH, FINAL_PPTX, TMP_DIR, WORKSPACE_DIR, PRESENTATIONS_SKILL_DIR, RUNTIME_NODE_MODULES, RUNTIME_PYTHON })) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
}

const spec = JSON.parse(await fs.readFile(SPEC_PATH, "utf8"));
execFileSync(RUNTIME_PYTHON, [fileURLToPath(new URL('./validate_two_slide_spec.py', import.meta.url)), SPEC_PATH], { stdio: 'inherit' });
if (spec.meta.templatePptx) throw new Error('This helper does not import templates. Use a task-specific template-preserving builder with drawSemanticDiagram; do not discard the supplied template.');
if ((spec.meta.slideSize?.width || 1280) !== 1280 || (spec.meta.slideSize?.height || 720) !== 720) throw new Error('Adapt chrome and result layout to the actual template size in a task-specific builder.');
if (spec.slide2.charts?.length !== 2 || spec.slide2.thirdModule?.type !== 'table') throw new Error('Adapt the result-page builder for these evidence themes; the starter only supports two charts plus a table.');
const require = createRequire(path.join(RUNTIME_NODE_MODULES, "runtime-entry.cjs"));
const { Presentation, PresentationFile } = require("@oai/artifact-tool");
await fs.mkdir(TMP_DIR, { recursive: true });
await fs.mkdir(path.dirname(FINAL_PPTX), { recursive: true });

const { finalizePresentation, applyPresentationChartFont } = await import(pathToFileURL(path.join(PRESENTATIONS_SKILL_DIR, "container_tools/artifact_tool_utils.mjs")).href);

const W = spec.meta.slideSize?.width || 1280;
const H = spec.meta.slideSize?.height || 720;
const FONT = spec.meta.fontFamily || "Microsoft YaHei";
const C = {
  navy: "#0B438C",
  navy2: "#0A5E8B",
  teal: "#169C98",
  cyan: "#39B8C5",
  red: "#C62828",
  ink: "#172A3A",
  gray: "#586B78",
  pale: "#EEF7FA",
  paleBlue: "#DCEEF8",
  paleTeal: "#E5F6F3",
  border: "#8EBCCB",
  grid: "#A6A6A6",
  white: "#FFFFFF",
};

const formulaSvgById = new Map();
const formulaPlacements = [];
const formulaCacheDir = path.join(TMP_DIR, "formula-runtime");
const formulaAssetDir = path.join(TMP_DIR, "formula-svg");
await fs.mkdir(formulaAssetDir, { recursive: true });
for (const formula of spec.slide1.formulas || []) {
  const svg = await renderLatexSvg({ latex: formula.latex, color: C.navy, cacheDir: formulaCacheDir });
  const svgWithMetadata = svg.replace(/(<svg\b[^>]*>)/i, `$1<metadata>${escapeXml(JSON.stringify({ id: formula.id, latex: formula.latex }))}</metadata>`);
  formulaSvgById.set(formula.id, svgWithMetadata);
  await fs.writeFile(path.join(formulaAssetDir, `${formula.id}.svg`), svgWithMetadata, "utf8");
}

const seriesPalette = {
  Hieroformer: { color: "#004BA0", width: 3.2, style: "solid", marker: "circle" },
  WPFormer: { color: "#004BA0", width: 3.2, style: "solid", marker: "circle" },
  "本文方法": { color: "#004BA0", width: 3.2, style: "solid", marker: "circle" },
  Pyraformer: { color: "#C00000", width: 2.4, style: "dashed", marker: "diamond" },
  FEDformer: { color: "#007A33", width: 2.4, style: "dash-dot", marker: "square" },
  Autoformer: { color: "#604A7B", width: 2.4, style: "dotted", marker: "triangle" },
};

const presentation = Presentation.create({ slideSize: { width: W, height: H } });
presentation.theme.colorScheme = {
  name: "Academic blue teal",
  themeColors: {
    accent1: C.navy, accent2: C.teal, accent3: C.cyan, accent4: "#E07A32",
    accent5: "#7A6BA8", accent6: C.paleBlue, bg1: C.white, bg2: C.pale,
    tx1: C.ink, tx2: C.gray, dk1: "#000000", dk2: C.ink,
    lt1: C.white, lt2: C.pale, hlink: C.navy, folHlink: C.teal,
  },
};

function addShape(slide, name, geometry, x, y, width, height, fill = "none", lineFill = "none", lineWidth = 0, radius = 0, lineStyle = "solid") {
  return slide.shapes.add({
    geometry,
    name,
    position: { left: x, top: y, width, height },
    fill,
    line: { style: lineStyle, fill: lineFill, width: lineWidth },
    ...(radius ? { borderRadius: radius } : {}),
  });
}

function addText(slide, name, value, x, y, width, height, style = {}, fill = "none", lineFill = "none", lineWidth = 0, radius = 0) {
  const box = addShape(slide, name, radius ? "roundRect" : "textbox", x, y, width, height, fill, lineFill, lineWidth, radius);
  box.text = value;
  box.text.style = {
    typeface: FONT,
    fontSize: 18,
    color: C.ink,
    autoFit: "shrinkText",
    wrap: "square",
    alignment: "left",
    verticalAlignment: "middle",
    insets: { left: 6, right: 6, top: 3, bottom: 3 },
    ...style,
  };
  return box;
}

function addLine(slide, name, x, y, dx, dy, color = C.cyan, width = 2, dashed = false) {
  let left = x; let top = y; let w = dx; let h = dy;
  let horizontalFlip = false; let verticalFlip = false;
  if (w < 0) { left += w; w = -w; horizontalFlip = true; }
  if (h < 0) { top += h; h = -h; verticalFlip = true; }
  return slide.shapes.add({
    geometry: "line",
    name,
    position: { left, top, width: w, height: h, horizontalFlip, verticalFlip },
    fill: "none",
    line: { style: dashed ? "dashed" : "solid", fill: color, width },
  });
}

function addRightArrow(slide, name, x, y, width = 24, height = 24) {
  return addShape(slide, name, "rightArrow", x, y, width, height, C.cyan, "none", 0);
}

function addSlideChrome(slide, title, summaryRuns) {
  slide.background.fill = C.white;
  addText(slide, "slide-title", title, 34, 22, 1212, 54, {
    fontSize: 38, bold: true, color: C.navy, alignment: "left",
    insets: { left: 0, right: 0, top: 0, bottom: 0 }, autoFit: "shrinkText",
  });
  addShape(slide, "title-rule", "rect", 0, 82, W, 5, C.navy, "none", 0);
  addShape(slide, "summary-box", "roundRect", 30, 102, 1220, 104, C.white, C.teal, 1.4, 8);
  const summary = addText(slide, "summary-text", "", 54, 112, 1172, 84, {
    fontSize: 24, bold: true, color: C.ink, alignment: "left",
    insets: { left: 8, right: 8, top: 4, bottom: 4 },
  });
  summary.text.set([{ runs: summaryRuns.map((run) => ({
    run: run.text,
    textStyle: {
      typeface: FONT,
      fontSize: "18pt",
      bold: run.bold ?? true,
      color: run.emphasis === "red" ? C.red : C.ink,
    },
  })) }]);
}

function addPanelShell(slide, id, x, title, conclusion) {
  const y = 229; const width = 396; const height = 447;
  addShape(slide, `${id}-outline`, "roundRect", x, y, width, height, C.white, C.border, 1.2, 8, "dashed");
  addText(slide, `${id}-header`, title, x + 86, y + 2, width - 172, 42, {
    fontSize: 21, bold: true, color: C.navy, alignment: "center",
    insets: { left: 3, right: 3, top: 0, bottom: 0 },
  }, C.paleBlue, "none", 0, 7);
  addText(slide, `${id}-conclusion`, conclusion, x + 2, y + height - 62, width - 4, 60, {
    fontSize: 19, bold: true, color: C.navy, alignment: "center",
    insets: { left: 8, right: 8, top: 3, bottom: 3 },
  }, C.paleTeal, "none", 0, 6);
  return { x, y, width, height };
}

function addFormula(slide, formula, x, y, width, height) {
  addShape(slide, `formula-${formula.id}`, "roundRect", x, y, width, height, "#F9FCFD", C.border, 0.8, 6);
  const svg = formulaSvgById.get(formula.id);
  if (!svg) throw new Error(`Formula SVG not found: ${formula.id}`);
  const position = containInBox(svg, { left: x + 8, top: y + 6, width: width - 16, height: height - 12 });
  const targetShapeName = `latex-svg-${formula.id}`;
  const image = slide.images.add({
    name: targetShapeName,
    blob: new TextEncoder().encode(svg),
    contentType: "image/svg+xml",
    alt: `LaTeX: ${formula.latex}`,
    fit: "contain",
    position,
  });
  if (image?.data) image.data.name = targetShapeName;
  formulaPlacements.push({
    ...formula,
    slide: 1,
    targetShapeName,
    position: { left: x + 8, top: y + 6, width: width - 16, height: height - 12 },
    color: C.navy,
  });
  return image;
}

async function createSlide1() {
  const slide = presentation.slides.add();
  addSlideChrome(slide, spec.slide1.title, spec.slide1.summaryRuns);
  const resolveSpec = p => path.resolve(path.dirname(SPEC_PATH), p);
  const graph = JSON.parse(await fs.readFile(resolveSpec(spec.slide1.semanticGraphPath), 'utf8'));
  const layout = JSON.parse(await fs.readFile(resolveSpec(spec.slide1.diagramLayoutPath), 'utf8'));
  if (layout.contentFrame.y < 224) throw new Error('The fixed starter header/summary occupies y=0..207. Start contentFrame at y>=224 or adapt the chrome in a task-specific builder.');
  const coverage = drawSemanticDiagram(slide, graph, layout);
  for (const formula of spec.slide1.formulas || []) {
    const box = layout.formulas?.[formula.id];
    if (!box || !['x','y','w','h'].every(k => Number.isFinite(box[k])) || box.w <= 0 || box.h <= 0) throw new Error(`Formula ${formula.id} requires an explicit adjacent box in diagram-layout.json.formulas`);
    addFormula(slide, formula, box.x, box.y, box.w, box.h);
  }
  await fs.writeFile(path.join(TMP_DIR, 'diagram-coverage.json'), JSON.stringify(coverage, null, 2), 'utf8');
  slide.speakerNotes.textFrame.setText(`来源：${spec.meta.paperTitle}，DOI ${spec.meta.doi}。方法证据：${spec.slide1.panels.map((panel) => panel.evidenceRef).join("；")}。公式证据：${(spec.slide1.formulas || []).map((formula) => formula.evidenceRef).join("；")}。未运行作者代码，内容为论文方法解读。`);
  return slide;
}

function addResultPanel(slide, id, x, title, conclusion) {
  return addPanelShell(slide, id, x, title, conclusion);
}

function addNativeLineChart(slide, chartSpec, frame, id) {
  const baselineStyles = [
    { color: "#C00000", width: 2.4, style: "dashed", marker: "diamond" },
    { color: "#007A33", width: 2.4, style: "dash-dot", marker: "square" },
    { color: "#604A7B", width: 2.4, style: "dotted", marker: "triangle" },
  ];
  const focusSeries = chartSpec.focusSeries || chartSpec.series.at(-1)?.name;
  const series = chartSpec.series.map((s, index) => {
    const p = seriesPalette[s.name] || (s.name === focusSeries
      ? { color: "#004BA0", width: 3.2, style: "solid", marker: "circle" }
      : baselineStyles[index % baselineStyles.length]);
    return {
      name: s.name,
      values: s.values,
      line: { style: p.style, fill: p.color, width: p.width },
      marker: { symbol: p.marker, size: s.name === focusSeries || ["Hieroformer", "WPFormer", "本文方法"].includes(s.name) ? 8 : 6 },
    };
  });
  const chart = slide.charts.add("line", {
    position: { left: frame.x + 12, top: frame.y + 51, width: frame.width - 24, height: 320 },
    categories: chartSpec.categories,
    series,
    hasLegend: true,
    legend: {
      position: "top", overlay: false,
      textStyle: { typeface: FONT, fontSize: 14, fill: C.ink },
    },
    lineOptions: { grouping: "standard", smooth: false, varyColors: false },
    xAxis: {
      visible: true,
      position: "bottom",
      tickLabelPosition: "nextTo",
      title: { text: chartSpec.xTitle, textStyle: { typeface: FONT, fontSize: 16, fill: C.ink } },
      textStyle: { typeface: FONT, fontSize: 14, fill: C.gray },
      line: { style: "solid", fill: "#595959", width: 1.5 },
      majorGridlines: { style: "dashed", fill: C.grid, width: 1.1 },
    },
    yAxis: {
      visible: true,
      position: "left",
      tickLabelPosition: "nextTo",
      title: { text: chartSpec.yTitle, textStyle: { typeface: FONT, fontSize: 16, fill: C.ink } },
      min: chartSpec.yMin,
      max: chartSpec.yMax,
      majorUnit: chartSpec.yMajorUnit,
      numberFormatCode: chartSpec.numberFormatCode || "0.0",
      textStyle: { typeface: FONT, fontSize: 14, fill: C.gray },
      line: { style: "solid", fill: "#595959", width: 1.5 },
      majorGridlines: { style: "dashed", fill: C.grid, width: 1.1 },
    },
    chartFill: C.white,
    chartLine: { style: "solid", fill: C.white, width: 0 },
    plotAreaFill: C.white,
    plotAreaLine: { style: "solid", fill: "#595959", width: 1.5 },
  });
  applyPresentationChartFont(chart, { fontFamily: FONT });
  return chart;
}

function addNativeTable(slide, tableSpec, frame) {
  const values = [tableSpec.headers, ...tableSpec.rows];
  const table = slide.tables.add({
    rows: values.length,
    columns: tableSpec.headers.length,
    left: frame.x + 28,
    top: frame.y + 88,
    width: frame.width - 56,
    height: 270,
    values,
  });
  table.styleOptions = { headerRow: true, bandedRows: true };
  table.borders.assign({ style: "solid", fill: C.border, width: 0.8 });
  for (let r = 0; r < values.length; r += 1) {
    for (let c = 0; c < tableSpec.headers.length; c += 1) {
      const cell = table.getCell(r, c);
      cell.fill = r === 0 ? C.navy : (r === 1 ? C.paleTeal : (r % 2 ? C.white : C.pale));
      cell.text.style = {
        typeface: FONT,
        fontSize: r === 0 ? 19 : 17,
        bold: r === 0 || r === 1,
        color: r === 0 ? C.white : (r === 1 ? C.navy : C.ink),
        alignment: "center",
        verticalAlignment: "middle",
        insets: { left: 3, right: 3, top: 2, bottom: 2 },
      };
    }
  }
  return table;
}

function createSlide2() {
  const slide = presentation.slides.add();
  addSlideChrome(slide, spec.slide2.title, spec.slide2.summaryRuns);
  if (spec.slide2.charts.length !== 2 || spec.slide2.thirdModule?.type !== "table") {
    throw new Error("The starter builder implements two charts plus a table. Adapt it for a third chart or sourced figure.");
  }
  const xs = [28, 442, 856];
  const frame1 = addResultPanel(slide, "s2p1", xs[0], spec.slide2.charts[0].title, spec.slide2.charts[0].conclusion);
  const frame2 = addResultPanel(slide, "s2p2", xs[1], spec.slide2.charts[1].title, spec.slide2.charts[1].conclusion);
  const frame3 = addResultPanel(slide, "s2p3", xs[2], spec.slide2.thirdModule.title, spec.slide2.thirdModule.conclusion);
  addNativeLineChart(slide, spec.slide2.charts[0], frame1, "s2-chart-1");
  addNativeLineChart(slide, spec.slide2.charts[1], frame2, "s2-chart-2");
  addNativeTable(slide, spec.slide2.thirdModule, frame3);
  slide.speakerNotes.textFrame.setText(`来源：${spec.meta.paperTitle}，DOI ${spec.meta.doi}。结果证据：${spec.slide2.charts.map((chart) => chart.evidenceRef).join("；")}；${spec.slide2.thirdModule.evidenceRef}。未运行作者代码，结果为论文公开结果的可编辑再表达。`);
  return slide;
}

await createSlide1();
createSlide2();

const formulaRevisionPath = FINAL_PPTX.replace(/\.pptx$/i, "-formula-revision.pptx");
await fs.writeFile(path.join(TMP_DIR, "formula-manifest.json"), `${JSON.stringify({
  sourcePptx: FINAL_PPTX,
  outputPptx: formulaRevisionPath,
  formulas: formulaPlacements,
}, null, 2)}\n`, "utf8");

const candidatePath = path.join(TMP_DIR, "candidate.pptx");
await (await PresentationFile.exportPptx(presentation)).save(candidatePath);

const result = await finalizePresentation({
  explicitTotalSlideCount: 2,
  requiredNativeTableOwnerSlides: [2],
  requiredNativeChartOwnerSlides: [2],
  materializeLiteralChartWorkbooks: true,
  nativeChartTargetApplication: "powerpoint",
  workspaceDir: WORKSPACE_DIR,
  candidatePath,
  finalPath: FINAL_PPTX,
  pythonExecutable: RUNTIME_PYTHON,
  integrityValidatorPath: path.join(PRESENTATIONS_SKILL_DIR, "container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(PRESENTATIONS_SKILL_DIR, "container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs: [
    "--expected-slide-size-emu", `${Math.round(W * 9525)},${Math.round(H * 9525)}`,
    "--validate-heading-fit",
    "--require-native-table-slide", "2",
  ],
  fontPolicy: { basis: "design", families: [FONT] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(TMP_DIR, `${path.basename(FINAL_PPTX)}.validation.json`),
});

console.log(JSON.stringify({ candidatePath, finalPath: FINAL_PPTX, result, deliveryStatus: 'AWAITING_FINAL_RENDER_REVIEW', next: 'Inspect both final renders, save visual-review.json, then run audit_graphic_delivery.py.' }, null, 2));

function containInBox(svg, box) {
  const viewBox = svg.match(/viewBox=["']([^"']+)["']/i)?.[1]?.trim().split(/\s+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite)) return box;
  const aspect = viewBox[2] / viewBox[3];
  const boxAspect = box.width / box.height;
  let width, height;
  if (aspect > boxAspect) { width = box.width; height = width / aspect; }
  else { height = box.height; width = height * aspect; }
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
