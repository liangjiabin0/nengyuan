import katex from 'katex';
import * as mathml2ommlModule from 'mathml2omml';
import { xml2js } from 'xml-js';
import {
  AlignmentType,
  convertToXmlComponent,
  Paragraph,
  TextRun,
  type ParagraphChild
} from 'docx';

const BODY_FONT = '宋体';
const BODY_SIZE = 24;
const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const mml2omml = resolveMml2Omml();

function resolveMml2Omml(): (input: string, options?: { disableDecode?: boolean }) => string {
  const mod = mathml2ommlModule as {
    mml2omml?: (input: string, options?: { disableDecode?: boolean }) => string;
    default?:
      | ((input: string, options?: { disableDecode?: boolean }) => string)
      | { mml2omml?: (input: string, options?: { disableDecode?: boolean }) => string };
  };
  if (typeof mod.mml2omml === 'function') return mod.mml2omml;
  if (typeof mod.default === 'function') return mod.default;
  if (mod.default && typeof mod.default.mml2omml === 'function') return mod.default.mml2omml;
  throw new Error('mathml2omml 未能正确加载');
}

type MathSegment =
  | { type: 'text'; value: string }
  | { type: 'math'; latex: string; display: boolean };

const MATH_TOKEN_RE =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|(?<!\$)\$(?!\$)([\s\S]+?)(?<!\$)\$(?!\$)|\\\(([\s\S]+?)\\\)/g;

export function splitTextWithMath(value: string): MathSegment[] {
  const source = value.replace(/\r\n?/g, '\n');
  const segments: MathSegment[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(MATH_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ type: 'text', value: source.slice(lastIndex, index) });
    }
    const latex = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
    const display = Boolean(match[1] || match[2]);
    if (latex) segments.push({ type: 'math', latex, display });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < source.length) {
    segments.push({ type: 'text', value: source.slice(lastIndex) });
  }
  return segments.length ? segments : [{ type: 'text', value: source }];
}

function extractMathMl(htmlOrMathml: string) {
  return htmlOrMathml.match(/<math\b[\s\S]*?<\/math>/i)?.[0] || '';
}

/** Strip KaTeX annotation payloads that mathml2omml does not support. */
function sanitizeMathMl(mathml: string) {
  return mathml
    .replace(/<annotation\b[\s\S]*?<\/annotation>/gi, '')
    .replace(/<semantics\b([^>]*)>/gi, '')
    .replace(/<\/semantics>/gi, '');
}

/** Read a balanced `{...}` group starting at openBraceIndex. */
function readBraceGroup(source: string, openBraceIndex: number): string | null {
  if (source[openBraceIndex] !== '{') return null;
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
  }
  return null;
}

/**
 * Ensure nary bodies like \\sum_{i=1}^{N}\\frac{a}{b} become
 * \\sum_{i=1}^{N}{\\frac{a}{b}} so OMML keeps the fraction inside the sum.
 */
export function normalizeLatexForOmml(latex: string): string {
  let result = latex
    .replace(/^\s*\\begin\{equation\*?\}/, '')
    .replace(/\\end\{equation\*?\}\s*$/, '')
    .replace(/\\tag\{[^}]*\}/g, '')
    .trim();

  const nary = /\\(sum|prod|int|oint|bigcup|bigcap)((?:_\{[^}]*\}|\^\{[^}]*\}|_\w|\^\w)*)/g;
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const match of result.matchAll(nary)) {
    const start = match.index ?? 0;
    const after = start + match[0].length;
    if (result[after] === '{') continue;
    if (!result.slice(after).match(/^\s*\\frac\b/)) continue;
    const fracIndex = result.indexOf('\\frac', after);
    if (fracIndex < 0) continue;
    let cursor = fracIndex + '\\frac'.length;
    while (result[cursor] === ' ') cursor += 1;
    const num = readBraceGroup(result, cursor);
    if (!num) continue;
    cursor += num.length;
    while (result[cursor] === ' ') cursor += 1;
    const den = readBraceGroup(result, cursor);
    if (!den) continue;
    const end = cursor + den.length;
    const body = result.slice(fracIndex, end);
    replacements.push({
      start: after,
      end,
      value: `{${body}}`
    });
  }

  for (const item of replacements.reverse()) {
    result = `${result.slice(0, item.start)}${item.value}${result.slice(item.end)}`;
  }
  return result;
}

function extractOMathInner(omml: string): string {
  const match = omml.match(/<m:oMath\b[^>]*>([\s\S]*)<\/m:oMath>/i);
  return match?.[1] ?? omml;
}

function findClosingTag(source: string, openIndex: number, tag: string): number {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source.startsWith(open, index) && /[\s/>]/.test(source[index + open.length] || '')) {
      // Self-closing open tags like <m:e/>
      const endAngle = source.indexOf('>', index);
      if (endAngle >= 0 && source[endAngle - 1] === '/') {
        if (depth === 0) return endAngle + 1;
        continue;
      }
      depth += 1;
      continue;
    }
    if (source.startsWith(close, index)) {
      depth -= 1;
      if (depth === 0) return index + close.length;
    }
  }
  return -1;
}

function readNextOmmlElement(source: string): { tag: string; xml: string; length: number } | null {
  const trimmed = source.match(/^\s*/)?.[0] || '';
  const start = trimmed.length;
  const match = source.slice(start).match(/^<(m:[a-zA-Z]+)\b/);
  if (!match) return null;
  const tag = match[1]!;
  const absolute = start;
  if (source[source.indexOf('>', absolute) - 1] === '/') {
    const end = source.indexOf('>', absolute) + 1;
    return { tag, xml: source.slice(absolute, end), length: end };
  }
  const end = findClosingTag(source, absolute, tag);
  if (end < 0) return null;
  return { tag, xml: source.slice(absolute, end), length: end };
}

/**
 * mathml2omml often emits <m:e/></m:nary><m:f>...</m:f> for \\sum\\frac.
 * Move the following sibling into the empty nary body so Word shows a true parsed sum.
 */
function repairEmptyNaryBodies(inner: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < inner.length) {
    const start = inner.indexOf('<m:nary', cursor);
    if (start < 0) {
      result += inner.slice(cursor);
      break;
    }
    result += inner.slice(cursor, start);
    const end = findClosingTag(inner, start, 'm:nary');
    if (end < 0) {
      result += inner.slice(start);
      break;
    }
    let block = inner.slice(start, end);
    if (/<m:e\s*\/>\s*$/.test(block.replace(/<\/m:nary>\s*$/, '')) || /<m:e\s*\/>\s*<\/m:nary>\s*$/.test(block)) {
      const next = readNextOmmlElement(inner.slice(end));
      if (next && next.tag !== 'm:oMath' && next.tag !== 'm:oMathPara') {
        block = block.replace(/<m:e\s*\/>\s*<\/m:nary>\s*$/, `<m:e>${next.xml}</m:e></m:nary>`);
        result += block;
        cursor = end + next.length;
        continue;
      }
    }
    result += block;
    cursor = end;
  }
  return result;
}

const MATH_FONT = 'Times New Roman';
const WORD_FONT_RPR =
  `<w:rPr><w:rFonts w:ascii="${MATH_FONT}" w:hAnsi="${MATH_FONT}" w:cs="${MATH_FONT}" w:eastAsia="${MATH_FONT}"/></w:rPr>`;

const TAG_NAME_START = /[A-Za-z/!?]/;

function escapeMathText(value: string): string {
  return value
    .replace(/&(?!(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function readTagEnd(source: string, start: number): number {
  let quote = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index + 1;
  }
  return source.length;
}

/**
 * mathml2omml leaves text outside any run — `<m:r>…<m:t>f</m:t></m:r>(x)</m:e>`
 * for an integrand, `<m:t>(</m:t></m:r>1+</m:e>` for a product — and writes
 * comparison operators raw. Word silently drops loose text, so the formula
 * renders short a term, and a raw `<` makes document.xml unparseable. Wrap the
 * strays in runs and escape every text node.
 */
function normalizeMathTextNodes(inner: string): string {
  let out = '';
  let loose = '';
  let index = 0;

  const flushLoose = () => {
    if (loose.trim()) {
      out += `<m:r><m:t xml:space="preserve">${escapeMathText(loose)}</m:t></m:r>`;
    }
    loose = '';
  };

  while (index < inner.length) {
    const char = inner[index]!;
    if (char === '<' && TAG_NAME_START.test(inner[index + 1] || '')) {
      flushLoose();
      const tagEnd = readTagEnd(inner, index);
      const tag = inner.slice(index, tagEnd);
      out += tag;
      index = tagEnd;
      if (/^<m:t\b/.test(tag) && !tag.endsWith('/>')) {
        // Slice to the closing tag instead of scanning: the content may hold a
        // raw "<" that must not be read as markup.
        const close = inner.indexOf('</m:t>', index);
        const end = close < 0 ? inner.length : close;
        out += escapeMathText(inner.slice(index, end));
        index = end;
      }
      continue;
    }
    loose += char;
    index += 1;
  }
  flushLoose();
  return out;
}

const MATH_RPR_CHILD = /<m:(lit|nor|scr|sty|brk|aln)\b[^>]*?(?:\/>|>[\s\S]*?<\/m:\1>)/g;

/**
 * Rebuild one m:r so it holds exactly one m:rPr and one w:rPr, in schema order
 * (m:rPr, w:rPr, then content). mathml2omml sometimes emits an empty w:rPr
 * before an empty m:rPr — for ∂ among others — and patching that with regexes
 * left duplicate property elements that fail strict XSD validation.
 */
function rebuildMathRun(run: string): string {
  const open = run.match(/^<m:r\b[^>]*>/)?.[0] ?? '<m:r>';
  let content = run.slice(open.length, run.length - '</m:r>'.length);
  let mathProps = '';
  content = content.replace(/<m:rPr\s*\/>|<m:rPr>([\s\S]*?)<\/m:rPr>/g, (_all, inner = '') => {
    mathProps += inner;
    return '';
  });
  content = content.replace(/<w:rPr\s*\/>|<w:rPr>[\s\S]*?<\/w:rPr>/g, '');

  const props = new Map<string, string>();
  for (const match of mathProps.matchAll(MATH_RPR_CHILD)) {
    if (!props.has(match[1]!)) props.set(match[1]!, match[0]);
  }
  const text = [...content.matchAll(/<m:t\b[^>]*>([^<]*)<\/m:t>/g)]
    .map((match) => match[1] || '')
    .join('');
  const originalStyle = props.get('sty')?.match(/m:val="([^"]*)"/)?.[1] ?? '';
  const bold = originalStyle === 'b' || originalStyle === 'bi';
  // \max, \sin, \log … reach here as plain runs ending in U+2061 FUNCTION APPLICATION.
  const upright = props.has('nor') || /^[\d\s.]+$/.test(text) || text.includes('⁡');
  const style = upright ? (bold ? 'b' : 'p') : (bold ? 'bi' : 'i');

  // CT_RPR: lit?, (nor | (scr?, sty?))?, brk?, aln? — nor is folded into sty.
  const ordered =
    (props.get('lit') ?? '')
    + (props.get('scr') ?? '')
    + `<m:sty m:val="${style}"/>`
    + (props.get('brk') ?? '')
    + (props.get('aln') ?? '');
  return `${open}<m:rPr>${ordered}</m:rPr>${WORD_FONT_RPR}${content}</m:r>`;
}

/**
 * MathType / Word 专业公式：变量默认斜体（m:sty=i），字体 Times New Roman；
 * \\mathrm 等 upright 文本保留正体（m:sty=p），\\mathbf 保留粗体。
 */
function decorateMathRuns(innerOmml: string): string {
  const result = innerOmml.replace(
    /<m:sty\s+m:val="undefined"\s*\/>/gi,
    '<m:sty m:val="p"/>'
  );
  return result.replace(/<m:r\b(?!Pr)[\s\S]*?<\/m:r>/g, rebuildMathRun);
}

function buildOmmlXml(inner: string, displayMode: boolean): string {
  const normalized = normalizeMathTextNodes(inner);
  const repaired = repairEmptyNaryBodies(normalized);
  const decorated = decorateMathRuns(repaired);
  const oMath =
    `<m:oMath xmlns:m="${MATH_NS}" xmlns:w="${WORD_NS}">${decorated}</m:oMath>`;
  if (!displayMode) return oMath;
  return (
    `<m:oMathPara xmlns:m="${MATH_NS}" xmlns:w="${WORD_NS}">`
    + '<m:oMathParaPr><m:jc m:val="center"/></m:oMathParaPr>'
    + oMath.replace(` xmlns:m="${MATH_NS}" xmlns:w="${WORD_NS}"`, '')
    + '</m:oMathPara>'
  );
}

export function latexToOmml(latex: string, displayMode = false): string | null {
  const cleaned = normalizeLatexForOmml(latex);
  if (!cleaned) return null;
  try {
    const rendered = katex.renderToString(cleaned, {
      output: 'mathml',
      throwOnError: false,
      displayMode,
      strict: 'ignore',
      trust: false
    });
    const mathml = sanitizeMathMl(extractMathMl(rendered));
    if (!mathml) return null;
    const rawOmml = mml2omml(mathml);
    if (!rawOmml?.includes('<m:oMath')) return null;
    return buildOmmlXml(extractOMathInner(rawOmml), displayMode);
  } catch {
    return null;
  }
}

/**
 * Convert OMML XML into a docx paragraph child.
 * Important: must feed convertToXmlComponent the first element node, not the
 * xml-js document root (otherwise Word gets an illegal <undefined> wrapper).
 */
export function ommlToDocxChild(omml: string): ParagraphChild | null {
  try {
    const parsed = xml2js(omml, { compact: false }) as {
      elements?: Array<Record<string, unknown>>;
    };
    const root = parsed.elements?.find((element) => element.type === 'element' || element.name);
    if (!root) return null;
    const component = convertToXmlComponent(root as never);
    return (component || null) as ParagraphChild | null;
  } catch {
    return null;
  }
}

export function latexToDocxMath(latex: string, displayMode = false): ParagraphChild | null {
  const omml = latexToOmml(latex, displayMode);
  if (!omml) return null;
  return ommlToDocxChild(omml);
}

function textRun(text: string, options: { bold?: boolean } = {}) {
  return new TextRun({
    text,
    font: BODY_FONT,
    size: BODY_SIZE,
    bold: options.bold
  });
}

function fallbackMathText(latex: string, display: boolean) {
  return display ? `$$${latex}$$` : `$${latex}$`;
}

function pushTextParagraph(
  paragraphs: Paragraph[],
  children: ParagraphChild[],
  options: { firstLine?: boolean; after?: number }
) {
  if (!children.length) return;
  paragraphs.push(new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: options.firstLine ? { firstLine: 480 } : undefined,
    spacing: { line: 360, after: options.after ?? 160 },
    children
  }));
}

/**
 * Build Word paragraphs that embed native OfficeMath (OMML) equations.
 * These render in Professional (parsed) view and remain editable in Word
 * (including Linear/LaTeX mode via the equation tools), similar to MathType.
 */
export function buildMathAwareParagraphs(
  value: string,
  options: { firstLine?: boolean; bold?: boolean; claimPrefix?: string } = {}
): Paragraph[] {
  const blocks = value
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n|\n(?=[一二三四五六七八九十]+、|\d+[.、])/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (!blocks.length) return [];

  const paragraphs: Paragraph[] = [];
  for (const block of blocks) {
    const segments = splitTextWithMath(
      options.claimPrefix ? `${options.claimPrefix}${block}` : block
    );
    let inlineChildren: ParagraphChild[] = [];

    const flushInline = (after = 160) => {
      pushTextParagraph(paragraphs, inlineChildren, {
        firstLine: options.firstLine,
        after
      });
      inlineChildren = [];
    };

    for (const segment of segments) {
      if (segment.type === 'text') {
        if (segment.value) {
          inlineChildren.push(textRun(segment.value, { bold: options.bold }));
        }
        continue;
      }

      if (segment.display) {
        flushInline(80);
        const mathChild = latexToDocxMath(segment.latex, true);
        paragraphs.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { line: 360, before: 120, after: 120 },
          children: mathChild
            ? [mathChild]
            : [textRun(fallbackMathText(segment.latex, true), { bold: options.bold })]
        }));
        continue;
      }

      const mathChild = latexToDocxMath(segment.latex, false);
      if (mathChild) inlineChildren.push(mathChild);
      else {
        inlineChildren.push(
          textRun(fallbackMathText(segment.latex, false), { bold: options.bold })
        );
      }
    }

    flushInline();
  }

  return paragraphs;
}

const MATH_PR_XML = [
  '<m:mathPr>',
  `<m:mathFont m:val="${MATH_FONT}"/>`,
  '<m:brkBin m:val="before"/>',
  '<m:brkBinSub m:val="--"/>',
  '<m:smallFrac m:val="0"/>',
  '<m:dispDef/>',
  '<m:lMargin m:val="0"/>',
  '<m:rMargin m:val="0"/>',
  '<m:defJc m:val="centerGroup"/>',
  '<m:wrapIndent m:val="1440"/>',
  '<m:intLim m:val="subSup"/>',
  '<m:naryLim m:val="undOvr"/>',
  '</m:mathPr>'
].join('');

/** Ensure word/settings.xml declares Office Math defaults for Professional rendering. */
export async function ensureDocxMathSettings(buffer: Buffer): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const settingsFile = zip.file('word/settings.xml');
  if (!settingsFile) return buffer;
  let settings = await settingsFile.async('string');
  let changed = false;

  if (/<m:mathPr[\s>]/.test(settings)) {
    const next = settings.replace(
      /<m:mathFont\b[^/]*\/>/g,
      `<m:mathFont m:val="${MATH_FONT}"/>`
    );
    if (next !== settings) {
      settings = next;
      changed = true;
    }
  } else {
    if (!/xmlns:m=/.test(settings)) {
      settings = settings.replace(
        /<w:settings\b([^>]*)>/,
        `<w:settings$1 xmlns:m="${MATH_NS}">`
      );
    }
    if (!/<\/w:settings>/.test(settings)) return buffer;
    settings = settings.replace('</w:settings>', `${MATH_PR_XML}</w:settings>`);
    changed = true;
  }

  if (!changed) return buffer;
  zip.file('word/settings.xml', settings);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}
