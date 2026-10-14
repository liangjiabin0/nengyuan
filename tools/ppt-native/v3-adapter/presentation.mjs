// 两页论文 PPT v3 的演示文稿适配层（基于 PptxGenJS，能元自有实现）。
//
// v3 技能脚本（draw_semantic_diagram.mjs、build_two_slide_deck.mjs）按“对象模型”编写：
//   presentation.slides.add() → slide.shapes / images / tables / charts.add(...)，
//   shape.text = '...'; shape.text.style = {...}; slide.speakerNotes.textFrame.setText(...)
// 这里只依据这些 v3 脚本自身实际用到的调用，在 PptxGenJS 上重新实现同样的调用形状，
// 并在导出时一次性生成原生可编辑的 PowerPoint 对象（文本框、形状、线、表格、图表）。
// 不包含、不链接任何第三方专有运行时。
//
// 坐标单位：与 v3 一致，按 1280×720 的“像素”给出，导出时换算成英寸（96 px = 1 in）。
import PptxGenJS from 'pptxgenjs';

const PX_PER_IN = 96;
const toIn = (px) => Number(px || 0) / PX_PER_IN;
const hex = (value) => {
  if (!value || value === 'none') return undefined;
  return String(value).replace(/^#/, '').toUpperCase();
};

/** v3 几何名 → PptxGenJS ShapeType。只收 v3 脚本实际用到的名字，其余明确报错。 */
const GEOMETRY = {
  textbox: 'rect',
  rect: 'rect',
  roundRect: 'roundRect',
  ellipse: 'ellipse',
  diamond: 'diamond',
  line: 'line',
  rightArrow: 'rightArrow',
  leftArrow: 'leftArrow',
  upArrow: 'upArrow',
  downArrow: 'downArrow'
};

const DASH = { solid: 'solid', dashed: 'dash', 'dash-dot': 'dashDot', dotted: 'sysDot' };
const ALIGN = { left: 'left', center: 'center', right: 'right', justify: 'justify' };
const VALIGN = { top: 'top', middle: 'middle', bottom: 'bottom' };
const MARKER = { circle: 'circle', diamond: 'diamond', square: 'square', triangle: 'triangle', none: 'none' };

function fontSizePt(size) {
  if (typeof size === 'number') return size;
  const m = String(size || '').match(/^([\d.]+)\s*pt$/i);
  return m ? Number(m[1]) : undefined;
}

function textOptions(style = {}) {
  const ins = style.insets || {};
  return {
    fontFace: style.typeface,
    fontSize: fontSizePt(style.fontSize),
    color: hex(style.color),
    bold: Boolean(style.bold),
    align: ALIGN[style.alignment] || 'left',
    valign: VALIGN[style.verticalAlignment] || 'middle',
    // PptxGenJS margin 单位是 pt，顺序 [左, 上, 右, 下]
    margin: [ins.left ?? 4, ins.top ?? 2, ins.right ?? 4, ins.bottom ?? 2].map((v) => Number(v) * 0.75),
    // v3 的机制图标签写的是 autoFit:'none'（固定字号），但其布局按论文标签长度给出，常装不下；
    // 这里对所有带框文字都按框尺寸计算可放下的字号（不低于 9pt），防止文字越出节点框。
    fit: 'shrink',
    wrap: style.wrap !== 'none'
  };
}

/** 形状上的文本：支持 `shape.text = '...'`、`shape.text.style = {...}`、`shape.text.set([...])`。 */
class TextBody {
  constructor(value = '') {
    this.value = String(value ?? '');
    this.style = {};
    this.paragraphs = null;
  }
  /** v3 用法：text.set([{ runs: [{ run, textStyle }] }]) */
  set(paragraphs) {
    this.paragraphs = Array.isArray(paragraphs) ? paragraphs : [];
    this.value = this.paragraphs.map((p) => (p.runs || []).map((r) => r.run ?? '').join('')).join('\n');
  }
  toPptx() {
    const base = textOptions(this.style);
    if (!this.paragraphs) return { runs: this.value, base };
    const runs = [];
    this.paragraphs.forEach((p, pi) => {
      (p.runs || []).forEach((r, ri) => {
        const ts = r.textStyle || {};
        runs.push({
          text: String(r.run ?? ''),
          options: {
            fontFace: ts.typeface || base.fontFace,
            fontSize: fontSizePt(ts.fontSize) || base.fontSize,
            color: hex(ts.color) || base.color,
            bold: ts.bold ?? base.bold,
            breakLine: ri === (p.runs.length - 1) && pi < this.paragraphs.length - 1
          }
        });
      });
    });
    return { runs, base };
  }
}

function textProperty(target) {
  let body = null;
  Object.defineProperty(target, 'text', {
    enumerable: true,
    get() {
      return body;
    },
    set(value) {
      if (value instanceof TextBody) body = value;
      else body = new TextBody(value);
    }
  });
}

class Shape {
  constructor(spec) {
    const geometry = spec.geometry || 'rect';
    if (!GEOMETRY[geometry]) throw new Error(`v3 适配层不支持的几何形状：${geometry}`);
    this.kind = 'shape';
    this.name = spec.name || '';
    this.geometry = geometry;
    this.position = { ...spec.position };
    this.fill = spec.fill;
    this.line = spec.line || {};
    this.borderRadius = spec.borderRadius || 0;
    textProperty(this);
  }
}

class ImageObject {
  constructor(spec) {
    this.kind = 'image';
    this.name = spec.name || '';
    this.position = { ...spec.position };
    this.alt = spec.alt || '';
    this.contentType = spec.contentType || 'image/png';
    this.blob = spec.blob;
    this.data = { name: this.name };
  }
}

class TableCell {
  constructor(value) {
    this.fill = undefined;
    textProperty(this);
    this.text = value;
  }
}

class TableObject {
  constructor(spec) {
    this.kind = 'table';
    this.rows = spec.rows;
    this.columns = spec.columns;
    this.position = { left: spec.left, top: spec.top, width: spec.width, height: spec.height };
    this.cells = (spec.values || []).map((row) => row.map((v) => new TableCell(v)));
    this.styleOptions = {};
    this.borderSpec = { style: 'solid', fill: '#8EBCCB', width: 0.8 };
    this.borders = { assign: (b) => Object.assign(this.borderSpec, b) };
  }
  getCell(r, c) {
    const cell = this.cells[r]?.[c];
    if (!cell) throw new Error(`表格单元格越界：(${r}, ${c})`);
    return cell;
  }
}

class ChartObject {
  constructor(type, spec) {
    if (!['line', 'bar', 'scatter'].includes(type)) throw new Error(`v3 适配层不支持的图表类型：${type}`);
    this.kind = 'chart';
    this.type = type;
    this.spec = spec;
    this.series = spec.series || [];
    this.fontFamily = undefined;
  }
}

class Slide {
  constructor() {
    this.objects = [];
    this.background = { fill: '#FFFFFF' };
    this.notes = '';
    const push = (Ctor) => (spec, extra) => {
      const obj = extra !== undefined ? new Ctor(spec, extra) : new Ctor(spec);
      this.objects.push(obj);
      return obj;
    };
    this.shapes = { add: push(Shape) };
    this.images = { add: push(ImageObject) };
    this.tables = { add: push(TableObject) };
    this.charts = { add: (type, spec) => { const c = new ChartObject(type, spec); this.objects.push(c); return c; } };
    this.speakerNotes = { textFrame: { setText: (t) => { this.notes = String(t ?? ''); } } };
  }
}

export class Presentation {
  static create({ slideSize = { width: 1280, height: 720 } } = {}) {
    return new Presentation(slideSize);
  }
  constructor(slideSize) {
    this.slideSize = slideSize;
    this.theme = { colorScheme: null };
    this.list = [];
    this.slides = { add: () => { const s = new Slide(); this.list.push(s); return s; }, items: this.list };
  }
}

function lineOptions(line = {}) {
  const color = hex(line.fill);
  if (!color || !line.width) return { type: 'none' };
  return { color, width: Number(line.width) * 0.75, dashType: DASH[line.style] || 'solid' };
}

function renderShape(pptx, slide, s) {
  const pos = s.position;
  const base = {
    x: toIn(pos.left), y: toIn(pos.top), w: toIn(pos.width), h: toIn(pos.height),
    flipH: Boolean(pos.horizontalFlip), flipV: Boolean(pos.verticalFlip)
  };
  const fill = hex(s.fill);
  const shapeType = pptx.ShapeType[GEOMETRY[s.geometry]];
  const common = {
    ...base,
    objectName: s.name || undefined,
    line: lineOptions(s.line),
    ...(s.geometry === 'line' ? {} : { fill: fill ? { color: fill } : { type: 'none' } }),
    ...(s.geometry === 'roundRect' ? { rectRadius: Math.min(0.5, toIn(s.borderRadius || 6) / Math.max(0.01, Math.min(base.w, base.h))) } : {})
  };
  const body = s.text;
  if (body && (body.value || body.paragraphs)) {
    const { runs, base: tb } = body.toPptx();
    const fitted = fitFontSize(body.value, tb, base.w, base.h, s.geometry);
    if (fitted < (tb.fontSize || 14)) {
      const ratio = fitted / (tb.fontSize || 14);
      tb.fontSize = fitted;
      if (Array.isArray(runs)) for (const r of runs) if (r.options?.fontSize) r.options.fontSize = Math.max(9, Math.round(r.options.fontSize * ratio * 2) / 2);
    }
    slide.addText(runs, { ...common, ...tb, shape: shapeType });
  } else {
    slide.addShape(shapeType, common);
  }
}

function renderImage(slide, img) {
  const pos = img.position;
  const data = Buffer.from(img.blob instanceof Uint8Array ? img.blob : Buffer.from(img.blob || '')).toString('base64');
  slide.addImage({
    data: `${img.contentType};base64,${data}`,
    x: toIn(pos.left), y: toIn(pos.top), w: toIn(pos.width), h: toIn(pos.height),
    altText: img.alt,
    objectName: img.name || undefined
  });
}

function renderTable(slide, t) {
  const border = { type: 'solid', pt: Number(t.borderSpec.width || 0.8), color: hex(t.borderSpec.fill) || '8EBCCB' };
  const pos = t.position;
  const colIn = Array.isArray(t.columnWidths) ? t.columnWidths.map(toIn) : null;
  const rowIn = toIn(pos.height) / Math.max(1, t.cells.length);
  // 每个单元格按列宽算出不拆单词的最大字号（不低于 9pt），再把整列统一到该列最小值，保持版面整齐
  const colSize = (t.cells[0] || []).map((_, c) => Math.min(...t.cells.map((row) => {
    const cell = row[c];
    const opts = cell?.text ? textOptions(cell.text.style) : { fontSize: 11, margin: [2, 1, 2, 1] };
    return fitFontSize(cell?.text?.value ?? '', { ...opts, fit: 'shrink' }, colIn ? colIn[c] : toIn(pos.width) / row.length, rowIn * 2.2);
  })));
  const rows = t.cells.map((row) => row.map((cell, c) => {
    const opts = cell.text ? textOptions(cell.text.style) : {};
    const fontSize = Math.min(opts.fontSize || 11, colSize[c]);
    return { text: cell.text?.value ?? '', options: { ...opts, fit: 'none', fontSize, fill: hex(cell.fill) ? { color: hex(cell.fill) } : undefined, border: [border, border, border, border] } };
  }));
  slide.addTable(rows, {
    x: toIn(pos.left), y: toIn(pos.top), w: toIn(pos.width), h: toIn(pos.height),
    rowH: toIn(pos.height) / Math.max(1, rows.length),
    ...(Array.isArray(t.columnWidths) && t.columnWidths.length === (rows[0]?.length || 0) ? { colW: t.columnWidths.map(toIn) } : {})
  });
}

function renderChart(pptx, slide, c) {
  const spec = c.spec;
  const font = c.fontFamily || spec.legend?.textStyle?.typeface;
  const data = c.series.map((s) => ({ name: s.name, labels: spec.categories, values: s.values }));
  const colors = c.series.map((s) => hex(s.line?.fill) || '0B438C');
  const ax = spec.xAxis || {};
  const ay = spec.yAxis || {};
  const grid = (g) => (g ? { color: hex(g.fill) || 'A6A6A6', style: DASH[g.style] === 'dash' ? 'dash' : 'solid', size: Number(g.width || 1) * 0.75 } : { style: 'none' });
  const pos = spec.position;
  slide.addChart(pptx.ChartType[c.type], data, {
    x: toIn(pos.left), y: toIn(pos.top), w: toIn(pos.width), h: toIn(pos.height),
    chartColors: colors,
    lineSize: c.series.map((s) => Number(s.line?.width || 2) * 0.75)[0],
    lineDataSymbol: MARKER[c.series[0]?.marker?.symbol] || 'circle',
    lineDataSymbolSize: c.series[0]?.marker?.size || 6,
    showLegend: spec.hasLegend !== false,
    legendPos: { top: 't', bottom: 'b', left: 'l', right: 'r' }[spec.legend?.position] || 't',
    legendFontFace: font,
    legendFontSize: spec.legend?.textStyle?.fontSize,
    showCatAxisTitle: Boolean(ax.title?.text),
    catAxisTitle: ax.title?.text,
    catAxisTitleFontSize: ax.title?.textStyle?.fontSize,
    catAxisLabelFontSize: ax.textStyle?.fontSize,
    catAxisLabelFontFace: font,
    catAxisLineColor: hex(ax.line?.fill),
    catGridLine: grid(ax.majorGridlines),
    showValAxisTitle: Boolean(ay.title?.text),
    valAxisTitle: ay.title?.text,
    valAxisTitleFontSize: ay.title?.textStyle?.fontSize,
    valAxisLabelFontSize: ay.textStyle?.fontSize,
    valAxisLabelFontFace: font,
    valAxisLineColor: hex(ay.line?.fill),
    valGridLine: grid(ay.majorGridlines),
    valAxisMinVal: ay.min,
    valAxisMaxVal: ay.max,
    valAxisMajorUnit: ay.majorUnit,
    valAxisLabelFormatCode: ay.numberFormatCode,
    plotArea: { fill: { color: hex(spec.plotAreaFill) || 'FFFFFF' }, border: { color: hex(spec.plotAreaLine?.fill) || '595959', pt: Number(spec.plotAreaLine?.width || 1) } },
    objectName: spec.name || undefined
  });
}

/**
 * 估算一段文字在给定框内按某字号需要多少行；用于把“缩字适应”真正落实到字号上。
 * PowerPoint 只在用户编辑时才重新计算 normAutofit，PptxGenJS 写出的 fit:'shrink' 打开后不会自动缩小，
 * 所以导出前按文字量直接算好字号，保证首次打开就不溢出。
 */
function fitFontSize(text, opts, wIn, hIn, geometry = 'rect') {
  const size = Number(opts.fontSize || 14);
  if (opts.fit !== 'shrink' || !text) return size;
  // 字宽按微软雅黑粗体的保守值估算：中文 1em，西文/数字约 0.62em（粗体比常规宽）
  const width = (ch) => (/[　-鿿＀-￯]/.test(ch) ? 1 : /[A-Z]/.test(ch) ? 0.7 : 0.6);
  const margin = Array.isArray(opts.margin) ? (opts.margin[0] + opts.margin[2]) / 72 : 0.1;
  const vmargin = Array.isArray(opts.margin) ? (opts.margin[1] + opts.margin[3]) / 72 : 0.05;
  // 菱形、椭圆、圆角框的可用文字区比外框小
  const inset = geometry === 'diamond' ? 0.5 : geometry === 'ellipse' ? 0.7 : geometry === 'roundRect' ? 0.9 : 1;
  const usableW = Math.max(0.2, wIn * inset - margin);
  const usableH = Math.max(0.15, hIn * inset - vmargin);
  for (let s = size; s >= 9; s -= 0.5) {
    const em = s / 72;
    let lines = 0;
    let fits = true;
    for (const para of String(text).split('\n')) {
      // 按单词换行：一个单词放不进一行就判定这个字号不行（否则 PowerPoint 会把单词拆开）
      const words = para.split(/(?<=[\s/–-])|(?=[　-鿿])/).filter(Boolean);
      let line = 0;
      lines += 1;
      for (const w of words) {
        const u = [...w].reduce((a, ch) => a + width(ch), 0) * em;
        if (u > usableW) { fits = false; break; }
        if (line + u > usableW) { lines += 1; line = u; } else line += u;
      }
      if (!fits) break;
    }
    if (fits && lines * em * 1.25 <= usableH) return s;
  }
  return 9;
}

/** 把对象模型导出成 PPTX（Buffer）。 */
export async function exportPptx(presentation, { title = '', author = '能元科研系统' } = {}) {
  const pptx = new PptxGenJS();
  const { width, height } = presentation.slideSize;
  pptx.defineLayout({ name: 'V3', width: toIn(width), height: toIn(height) });
  pptx.layout = 'V3';
  pptx.author = author;
  pptx.title = title;
  for (const s of presentation.list) {
    const slide = pptx.addSlide();
    if (hex(s.background.fill)) slide.background = { color: hex(s.background.fill) };
    for (const obj of s.objects) {
      if (obj.kind === 'shape') renderShape(pptx, slide, obj);
      else if (obj.kind === 'image') renderImage(slide, obj);
      else if (obj.kind === 'table') renderTable(slide, obj);
      else if (obj.kind === 'chart') renderChart(pptx, slide, obj);
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
}

export const PresentationFile = {
  async exportPptx(presentation, opts) {
    const buffer = await exportPptx(presentation, opts);
    return { buffer, async save(file) { const fs = await import('node:fs/promises'); await fs.writeFile(file, buffer); } };
  }
};

/** v3 的 applyPresentationChartFont：记录字体，导出图表时使用。 */
export function applyPresentationChartFont(chart, { fontFamily } = {}) {
  if (chart) chart.fontFamily = fontFamily;
}
