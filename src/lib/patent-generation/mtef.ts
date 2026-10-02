import * as XLSX from "xlsx";

export type MtefConfidence = "high" | "medium" | "low";

export interface MtefConversionResult {
  latex: string;
  confidence: MtefConfidence;
  warnings: string[];
}

type Severity = "medium" | "low";

interface CfbEntry {
  content?: Uint8Array | Buffer | string;
}

interface CfbContainer {
  FullPaths: string[];
  FileIndex: CfbEntry[];
}

interface CharNode {
  kind: "char";
  mtCode: number;
  typeface: number;
  options: number;
  embellishments: number[];
  usedFontPosition: boolean;
}

interface LineNode {
  kind: "line";
  children: MtefNode[];
  placeholder: boolean;
}

interface TemplateNode {
  kind: "template";
  selector: number;
  variation: number;
  children: MtefNode[];
}

interface PileNode {
  kind: "pile";
  children: MtefNode[];
}

interface MatrixNode {
  kind: "matrix";
  rows: number;
  columns: number;
  children: MtefNode[];
}

type MtefNode = CharNode | LineNode | TemplateNode | PileNode | MatrixNode;

const RECORD_END = 0;
const RECORD_LINE = 1;
const RECORD_CHAR = 2;
const RECORD_TEMPLATE = 3;
const RECORD_PILE = 4;
const RECORD_MATRIX = 5;
const RECORD_EMBELL = 6;
const RECORD_RULER = 7;
const RECORD_FONT_STYLE_DEF = 8;
const RECORD_SIZE = 9;
const RECORD_FULL = 10;
const RECORD_SUB = 11;
const RECORD_SUB2 = 12;
const RECORD_SYM = 13;
const RECORD_SUBSYM = 14;
const RECORD_COLOR = 15;
const RECORD_COLOR_DEF = 16;
const RECORD_FONT_DEF = 17;
const RECORD_EQN_PREFS = 18;
const RECORD_ENCODING_DEF = 19;
const RECORD_FUTURE = 100;

const OPT_NUDGE = 0x08;
const OPT_CHAR_EMBELL = 0x01;
const OPT_CHAR_ENC_8 = 0x04;
const OPT_CHAR_ENC_16 = 0x10;
const OPT_CHAR_NO_MTCODE = 0x20;
const OPT_LINE_NULL = 0x01;
const OPT_LP_RULER = 0x02;
const OPT_LINE_SPACING = 0x04;

const TEMPLATE_ROOT = 10;
const TEMPLATE_FRACTION = 11;
const TEMPLATE_UNDERBAR = 12;
const TEMPLATE_OVERBAR = 13;
const TEMPLATE_ARROW = 14;
const TEMPLATE_INTEGRAL = 15;
const TEMPLATE_SUM = 16;
const TEMPLATE_PRODUCT = 17;
const TEMPLATE_COPRODUCT = 18;
const TEMPLATE_UNION = 19;
const TEMPLATE_INTERSECTION = 20;
const TEMPLATE_INTEGRAL_OPERATOR = 21;
const TEMPLATE_SUM_OPERATOR = 22;
const TEMPLATE_LIMIT = 23;
const TEMPLATE_HORIZONTAL_BRACE = 24;
const TEMPLATE_HORIZONTAL_BRACKET = 25;
const TEMPLATE_LONG_DIVISION = 26;
const TEMPLATE_SUBSCRIPT = 27;
const TEMPLATE_SUPERSCRIPT = 28;
const TEMPLATE_SUBSUP = 29;
const TEMPLATE_DIRAC = 30;
const TEMPLATE_VECTOR = 31;
const TEMPLATE_TILDE = 32;
const TEMPLATE_HAT = 33;
const TEMPLATE_ARC = 34;
const TEMPLATE_JOINT_STATUS = 35;
const TEMPLATE_STRIKE = 36;
const TEMPLATE_BOX = 37;

/**
 * Unicode/MTCode characters whose mathematical LaTeX spelling is not the
 * character itself. MTEF 5 uses a superset of Unicode, so printable Unicode
 * remains a useful, explicitly warned fallback for less common characters.
 */
const LATEX_BY_MTCODE: Readonly<Record<number, string>> = {
  0x00a0: "~",
  0x00ac: "\\neg ",
  0x00b0: "^{\\circ}",
  0x00b1: "\\pm ",
  0x00b7: "\\cdot ",
  0x00d7: "\\times ",
  0x00f7: "\\div ",
  0x0391: "A",
  0x0392: "B",
  0x0393: "\\Gamma ",
  0x0394: "\\Delta ",
  0x0395: "E",
  0x0396: "Z",
  0x0397: "H",
  0x0398: "\\Theta ",
  0x0399: "I",
  0x039a: "K",
  0x039b: "\\Lambda ",
  0x039c: "M",
  0x039d: "N",
  0x039e: "\\Xi ",
  0x039f: "O",
  0x03a0: "\\Pi ",
  0x03a1: "P",
  0x03a3: "\\Sigma ",
  0x03a4: "T",
  0x03a5: "\\Upsilon ",
  0x03a6: "\\Phi ",
  0x03a7: "X",
  0x03a8: "\\Psi ",
  0x03a9: "\\Omega ",
  0x03b1: "\\alpha ",
  0x03b2: "\\beta ",
  0x03b3: "\\gamma ",
  0x03b4: "\\delta ",
  0x03b5: "\\varepsilon ",
  0x03b6: "\\zeta ",
  0x03b7: "\\eta ",
  0x03b8: "\\theta ",
  0x03b9: "\\iota ",
  0x03ba: "\\kappa ",
  0x03bb: "\\lambda ",
  0x03bc: "\\mu ",
  0x03bd: "\\nu ",
  0x03be: "\\xi ",
  0x03bf: "o",
  0x03c0: "\\pi ",
  0x03c1: "\\rho ",
  0x03c2: "\\varsigma ",
  0x03c3: "\\sigma ",
  0x03c4: "\\tau ",
  0x03c5: "\\upsilon ",
  0x03c6: "\\varphi ",
  0x03c7: "\\chi ",
  0x03c8: "\\psi ",
  0x03c9: "\\omega ",
  0x03d1: "\\vartheta ",
  0x03d5: "\\phi ",
  0x03d6: "\\varpi ",
  0x03f0: "\\varkappa ",
  0x03f1: "\\varrho ",
  0x03f5: "\\epsilon ",
  0x2016: "\\Vert ",
  0x2020: "\\dagger ",
  0x2021: "\\ddagger ",
  0x2022: "\\bullet ",
  0x2026: "\\ldots ",
  0x2032: "\\prime ",
  0x2033: "\\prime\\prime ",
  0x2034: "\\prime\\prime\\prime ",
  0x2035: "\\backprime ",
  0x2102: "\\mathbb{C}",
  0x2113: "\\ell ",
  0x2115: "\\mathbb{N}",
  0x2118: "\\wp ",
  0x211c: "\\Re ",
  0x211d: "\\mathbb{R}",
  0x2124: "\\mathbb{Z}",
  0x2135: "\\aleph ",
  0x2190: "\\leftarrow ",
  0x2191: "\\uparrow ",
  0x2192: "\\to ",
  0x2193: "\\downarrow ",
  0x2194: "\\leftrightarrow ",
  0x21a6: "\\mapsto ",
  0x21d0: "\\Leftarrow ",
  0x21d1: "\\Uparrow ",
  0x21d2: "\\Rightarrow ",
  0x21d3: "\\Downarrow ",
  0x21d4: "\\Leftrightarrow ",
  0x2200: "\\forall ",
  0x2202: "\\partial ",
  0x2203: "\\exists ",
  0x2205: "\\varnothing ",
  0x2207: "\\nabla ",
  0x2208: "\\in ",
  0x2209: "\\notin ",
  0x220b: "\\ni ",
  0x220f: "\\prod ",
  0x2210: "\\coprod ",
  0x2211: "\\sum ",
  0x2212: "-",
  0x2213: "\\mp ",
  0x2215: "/",
  0x2217: "*",
  0x2218: "\\circ ",
  0x2219: "\\bullet ",
  0x221a: "\\surd ",
  0x221d: "\\propto ",
  0x221e: "\\infty ",
  0x221f: "\\perp ",
  0x2220: "\\angle ",
  0x2223: "\\mid ",
  0x2225: "\\parallel ",
  0x2227: "\\wedge ",
  0x2228: "\\vee ",
  0x2229: "\\cap ",
  0x222a: "\\cup ",
  0x222b: "\\int ",
  0x222c: "\\iint ",
  0x222d: "\\iiint ",
  0x222e: "\\oint ",
  0x2234: "\\therefore ",
  0x2235: "\\because ",
  0x223c: "\\sim ",
  0x2243: "\\simeq ",
  0x2245: "\\cong ",
  0x2248: "\\approx ",
  0x2250: "\\doteq ",
  0x2260: "\\ne ",
  0x2261: "\\equiv ",
  0x2264: "\\le ",
  0x2265: "\\ge ",
  0x226a: "\\ll ",
  0x226b: "\\gg ",
  0x227a: "\\prec ",
  0x227b: "\\succ ",
  0x227c: "\\preceq ",
  0x227d: "\\succeq ",
  0x2282: "\\subset ",
  0x2283: "\\supset ",
  0x2286: "\\subseteq ",
  0x2287: "\\supseteq ",
  0x228a: "\\subsetneq ",
  0x228b: "\\supsetneq ",
  0x2295: "\\oplus ",
  0x2297: "\\otimes ",
  0x22a5: "\\bot ",
  0x22c0: "\\bigwedge ",
  0x22c1: "\\bigvee ",
  0x22c2: "\\bigcap ",
  0x22c3: "\\bigcup ",
  0x22c5: "\\cdot ",
  0x22ee: "\\vdots ",
  0x22ef: "\\cdots ",
  0x22f1: "\\ddots ",
  0x3001: "\\text{、}",
  0x548c: "\\text{和}",
  0xec07: "\\lvert ",
  0xec08: "\\rvert ",
  0xef04: "\\ ",
  0xef08: "\\ ",
};

class BinaryReader {
  offset = 0;

  constructor(readonly data: Buffer) {}

  get remaining(): number {
    return this.data.length - this.offset;
  }

  ensure(length: number, context: string): void {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new Error(
        `MTEF stream ended while reading ${context} at byte ${this.offset}`,
      );
    }
  }

  peekU8(context: string): number {
    this.ensure(1, context);
    return this.data[this.offset]!;
  }

  u8(context: string): number {
    this.ensure(1, context);
    return this.data[this.offset++]!;
  }

  u16(context: string): number {
    this.ensure(2, context);
    const value = this.data.readUInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  i16(context: string): number {
    this.ensure(2, context);
    const value = this.data.readInt16LE(this.offset);
    this.offset += 2;
    return value;
  }

  skip(length: number, context: string): void {
    this.ensure(length, context);
    this.offset += length;
  }

  cString(context: string): string {
    const end = this.data.indexOf(0, this.offset);
    if (end < 0) {
      throw new Error(`Unterminated ${context} at byte ${this.offset}`);
    }
    const value = this.data.toString("latin1", this.offset, end);
    this.offset = end + 1;
    return value;
  }
}

class MtefParser {
  private readonly warnings = new Set<string>();
  private worstSeverity: Severity | undefined;
  private nodeCount = 0;

  constructor(private readonly reader: BinaryReader) {}

  parse(): MtefConversionResult {
    const version = this.reader.u8("MTEF version");
    if (version !== 5) {
      throw new Error(`Unsupported MTEF version ${version}; expected version 5`);
    }

    this.reader.u8("generating platform");
    this.reader.u8("generating product");
    this.reader.u8("product version");
    this.reader.u8("product subversion");
    const application = this.reader.cString("MTEF application key");
    this.reader.u8("equation options");

    if (!/^DSMT\d+$/i.test(application)) {
      this.note(`Unexpected MTEF application key "${application || "(empty)"}".`);
    }

    const nodes = this.parseObjectList("equation", 0);
    if (this.reader.remaining > 0) {
      const trailing = this.reader.data.subarray(this.reader.offset);
      if (trailing.some((value) => value !== 0)) {
        this.note(
          `Ignored ${trailing.length} trailing byte(s) after the equation.`,
        );
      }
    }

    const latex = this.renderSequence(nodes).trim();
    if (!latex) {
      throw new Error("MTEF equation contained no renderable formula");
    }

    return {
      latex,
      confidence:
        this.worstSeverity === "low"
          ? "low"
          : this.warnings.size > 0
            ? "medium"
            : "high",
      warnings: [...this.warnings],
    };
  }

  addExternalWarning(message: string, severity: Severity = "medium"): void {
    this.note(message, severity);
  }

  private note(message: string, severity: Severity = "medium"): void {
    this.warnings.add(message);
    if (severity === "low") {
      this.worstSeverity = "low";
    } else if (!this.worstSeverity) {
      this.worstSeverity = severity;
    }
  }

  private parseObjectList(context: string, depth: number): MtefNode[] {
    if (depth > 128) {
      throw new Error("MTEF nesting exceeds the safe limit of 128 levels");
    }

    const nodes: MtefNode[] = [];
    while (true) {
      const type = this.reader.u8(`${context} record type`);
      if (type === RECORD_END) {
        return nodes;
      }
      const node = this.parseRecord(type, depth + 1);
      if (node) {
        nodes.push(node);
        this.nodeCount += 1;
        if (this.nodeCount > 100_000) {
          throw new Error("MTEF equation exceeds the safe node limit");
        }
      }
    }
  }

  private parseRecord(type: number, depth: number): MtefNode | undefined {
    if (type >= RECORD_FUTURE) {
      const length = this.readUnsigned("future record length");
      this.reader.skip(length, `future record ${type}`);
      this.note(`Skipped unsupported future MTEF record ${type}.`);
      return undefined;
    }

    switch (type) {
      case RECORD_LINE:
        return this.parseLine(depth);
      case RECORD_CHAR:
        return this.parseChar(depth);
      case RECORD_TEMPLATE:
        return this.parseTemplate(depth);
      case RECORD_PILE:
        return this.parsePile(depth);
      case RECORD_MATRIX:
        return this.parseMatrix(depth);
      case RECORD_EMBELL:
        throw new Error("Unexpected standalone EMBELL record");
      case RECORD_RULER:
        this.parseRuler(false);
        return undefined;
      case RECORD_FONT_STYLE_DEF:
        this.readUnsigned("font definition index");
        this.reader.u8("font character style");
        return undefined;
      case RECORD_SIZE:
        this.parseSize();
        return undefined;
      case RECORD_FULL:
      case RECORD_SUB:
      case RECORD_SUB2:
      case RECORD_SYM:
      case RECORD_SUBSYM:
        return undefined;
      case RECORD_COLOR:
        this.readUnsigned("color definition index");
        return undefined;
      case RECORD_COLOR_DEF:
        this.parseColorDefinition();
        return undefined;
      case RECORD_FONT_DEF:
        this.readUnsigned("font encoding index");
        this.reader.cString("font name");
        return undefined;
      case RECORD_EQN_PREFS:
        this.parseEquationPreferences();
        return undefined;
      case RECORD_ENCODING_DEF:
        this.reader.cString("encoding name");
        return undefined;
      default:
        throw new Error(
          `Unsupported MTEF record type ${type} at byte ${this.reader.offset - 1}`,
        );
    }
  }

  private parseLine(depth: number): LineNode {
    const options = this.reader.u8("LINE options");
    this.skipNudge(options, "LINE");
    if ((options & OPT_LINE_SPACING) !== 0) {
      this.reader.i16("LINE spacing");
    }
    if ((options & OPT_LP_RULER) !== 0) {
      this.parseRuler(true);
    }

    const placeholder = (options & OPT_LINE_NULL) !== 0;
    return {
      kind: "line",
      placeholder,
      children: placeholder ? [] : this.parseObjectList("LINE", depth),
    };
  }

  private parseChar(depth: number): CharNode {
    const options = this.reader.u8("CHAR options");
    this.skipNudge(options, "CHAR");
    const typeface = this.readSigned("CHAR typeface");
    let mtCode: number | undefined;
    let fontPosition: number | undefined;

    if ((options & OPT_CHAR_NO_MTCODE) === 0) {
      mtCode = this.reader.u16("CHAR MTCode");
    }
    if ((options & OPT_CHAR_ENC_8) !== 0) {
      fontPosition = this.reader.u8("CHAR 8-bit font position");
    }
    if ((options & OPT_CHAR_ENC_16) !== 0) {
      fontPosition = this.reader.u16("CHAR 16-bit font position");
    }

    const usedFontPosition = mtCode === undefined;
    if (mtCode === undefined) {
      if (fontPosition === undefined) {
        throw new Error("CHAR record has neither MTCode nor font position");
      }
      mtCode = fontPosition;
      this.note(
        `CHAR without MTCode used font position U+${hexCode(mtCode)} as a fallback.`,
        "low",
      );
    }

    const embellishments: number[] = [];
    if ((options & OPT_CHAR_EMBELL) !== 0) {
      while (true) {
        const record = this.reader.u8("CHAR embellishment record");
        if (record === RECORD_END) {
          break;
        }
        if (record !== RECORD_EMBELL) {
          throw new Error(
            `Expected EMBELL record in CHAR list, found record ${record}`,
          );
        }
        const embellOptions = this.reader.u8("EMBELL options");
        this.skipNudge(embellOptions, "EMBELL");
        embellishments.push(this.reader.u8("embellishment type"));
      }
    }

    return {
      kind: "char",
      mtCode,
      typeface,
      options,
      embellishments,
      usedFontPosition,
    };
  }

  private parseTemplate(depth: number): TemplateNode {
    const options = this.reader.u8("TMPL options");
    this.skipNudge(options, "TMPL");
    const selector = this.reader.u8("template selector");
    const firstVariationByte = this.reader.u8("template variation");
    const variation =
      (firstVariationByte & 0x80) !== 0
        ? (firstVariationByte & 0x7f) |
          (this.reader.u8("extended template variation") << 8)
        : firstVariationByte;
    this.reader.u8("template-specific options");
    return {
      kind: "template",
      selector,
      variation,
      children: this.parseObjectList(`template ${selector}`, depth),
    };
  }

  private parsePile(depth: number): PileNode {
    const options = this.reader.u8("PILE options");
    this.skipNudge(options, "PILE");
    this.reader.u8("PILE horizontal alignment");
    this.reader.u8("PILE vertical alignment");
    if ((options & OPT_LP_RULER) !== 0) {
      this.parseRuler(true);
    }
    return {
      kind: "pile",
      children: this.parseObjectList("PILE", depth),
    };
  }

  private parseMatrix(depth: number): MatrixNode {
    const options = this.reader.u8("MATRIX options");
    this.skipNudge(options, "MATRIX");
    this.reader.u8("MATRIX vertical alignment");
    this.reader.u8("MATRIX horizontal justification");
    this.reader.u8("MATRIX vertical justification");
    const rows = this.reader.u8("MATRIX row count");
    const columns = this.reader.u8("MATRIX column count");
    if (rows === 0 || columns === 0) {
      throw new Error(`Invalid ${rows}x${columns} MTEF matrix`);
    }

    const rowPartitionBytes = Math.ceil((rows + 1) / 4);
    const columnPartitionBytes = Math.ceil((columns + 1) / 4);
    const partitions = this.reader.data.subarray(
      this.reader.offset,
      this.reader.offset + rowPartitionBytes + columnPartitionBytes,
    );
    this.reader.skip(
      rowPartitionBytes + columnPartitionBytes,
      "MATRIX partition lines",
    );
    if (partitions.some((value: number) => value !== 0)) {
      this.note("Matrix partition-line styling was omitted from LaTeX output.");
    }

    return {
      kind: "matrix",
      rows,
      columns,
      children: this.parseObjectList("MATRIX", depth),
    };
  }

  private parseRuler(expectTag: boolean): void {
    // DSMT7 emits the embedded ruler payload without the type-7 tag even
    // though the MTEF 5 document describes it as a nested RULER record.
    if (
      expectTag &&
      this.reader.peekU8("RULER record or tab-stop count") === RECORD_RULER
    ) {
      this.reader.u8("RULER record type");
    }
    const stops = this.readUnsigned("RULER tab-stop count");
    for (let index = 0; index < stops; index += 1) {
      this.reader.u8("RULER tab-stop type");
      this.reader.i16("RULER tab-stop offset");
    }
  }

  private parseSize(): void {
    const kind = this.reader.u8("SIZE kind");
    if (kind === 101) {
      this.reader.u16("explicit point size");
    } else if (kind === 100) {
      this.reader.u8("SIZE logical size");
      this.reader.i16("SIZE delta");
    } else {
      this.reader.u8("SIZE delta");
    }
  }

  private parseColorDefinition(): void {
    const options = this.reader.u8("COLOR_DEF options");
    const components = (options & 0x01) !== 0 ? 4 : 3;
    for (let index = 0; index < components; index += 1) {
      this.reader.u16("COLOR_DEF component");
    }
    if ((options & 0x04) !== 0) {
      this.reader.cString("COLOR_DEF name");
    }
  }

  private parseEquationPreferences(): void {
    this.reader.u8("EQN_PREFS options");
    this.skipDimensionArray("equation sizes");
    this.skipDimensionArray("equation spacing");
    const styleCount = this.reader.u8("style definition count");
    for (let index = 0; index < styleCount; index += 1) {
      const fontDefinition = this.readUnsigned("style font definition");
      if (fontDefinition !== 0) {
        this.reader.u8("style character style");
      }
    }
  }

  private skipDimensionArray(context: string): void {
    const count = this.reader.u8(`${context} count`);
    let completed = 0;
    let expectingUnits = true;
    while (completed < count) {
      const packed = this.reader.u8(`${context} dimensions`);
      const nibbles = [packed >>> 4, packed & 0x0f];
      for (const nibble of nibbles) {
        if (completed >= count) {
          break;
        }
        if (expectingUnits) {
          if (nibble > 4) {
            throw new Error(`Invalid units nibble in ${context}`);
          }
          expectingUnits = false;
        } else if (nibble === 0x0f) {
          completed += 1;
          expectingUnits = true;
        } else if (nibble > 0x0b) {
          throw new Error(`Invalid value nibble in ${context}`);
        }
      }
    }
  }

  private skipNudge(options: number, context: string): void {
    if ((options & OPT_NUDGE) === 0) {
      return;
    }
    const x = this.reader.u8(`${context} nudge x`);
    const y = this.reader.u8(`${context} nudge y`);
    if (x === 128 || y === 128) {
      this.reader.i16(`${context} extended nudge x`);
      this.reader.i16(`${context} extended nudge y`);
    }
  }

  private readUnsigned(context: string): number {
    const first = this.reader.u8(context);
    return first === 255 ? this.reader.u16(context) : first;
  }

  private readSigned(context: string): number {
    const first = this.reader.u8(context);
    return first === 255 ? this.reader.u16(context) - 32768 : first - 128;
  }

  private renderSequence(nodes: readonly MtefNode[]): string {
    let output = "";
    for (let index = 0; index < nodes.length; ) {
      const node = nodes[index]!;
      if (
        node.kind === "char" &&
        node.typeface === 1 &&
        node.embellishments.length === 0
      ) {
        const run: CharNode[] = [];
        while (index < nodes.length) {
          const candidate = nodes[index]!;
          if (
            candidate.kind !== "char" ||
            candidate.typeface !== 1 ||
            candidate.embellishments.length !== 0
          ) {
            break;
          }
          run.push(candidate);
          index += 1;
        }
        output += `\\text{${run
          .map((character) => escapeLatexText(codePointToText(character.mtCode)))
          .join("")}}`;
        continue;
      }
      if (
        node.kind === "char" &&
        node.typeface === 2 &&
        isFunctionLetter(node.mtCode) &&
        node.embellishments.length === 0
      ) {
        const run: CharNode[] = [];
        while (index < nodes.length) {
          const candidate = nodes[index]!;
          if (
            candidate.kind !== "char" ||
            candidate.typeface !== 2 ||
            !isFunctionLetter(candidate.mtCode) ||
            candidate.embellishments.length !== 0
          ) {
            break;
          }
          run.push(candidate);
          index += 1;
        }
        output += `\\operatorname{${run
          .map((character) => escapeLatexText(codePointToText(character.mtCode)))
          .join("")}}`;
        continue;
      }
      output += this.renderNode(node);
      index += 1;
    }
    return output;
  }

  private renderNode(node: MtefNode): string {
    switch (node.kind) {
      case "char":
        return this.renderChar(node);
      case "line":
        return node.placeholder ? "" : this.renderSequence(node.children);
      case "pile": {
        const lines = node.children.map((child) => this.renderNode(child));
        if (lines.length <= 1) {
          return lines[0] ?? "";
        }
        return `\\begin{gathered}${lines.join("\\\\")}\\end{gathered}`;
      }
      case "matrix":
        return this.renderMatrix(node);
      case "template":
        return this.renderTemplate(node);
    }
  }

  private renderChar(node: CharNode): string {
    let value = this.renderMtCode(node.mtCode);
    for (const embellishment of node.embellishments) {
      switch (embellishment) {
        case 2:
          value = `\\dot{${value}}`;
          break;
        case 3:
          value = `\\ddot{${value}}`;
          break;
        case 4:
          value = `\\overset{\\dots}{${value}}`;
          break;
        case 5:
          value = `${value}^{\\prime}`;
          break;
        case 6:
          value = `${value}^{\\prime\\prime}`;
          break;
        case 7:
          value = `{}^{\\backprime}${value}`;
          break;
        case 8:
          value = `\\widetilde{${value}}`;
          break;
        case 9:
          value = `\\widehat{${value}}`;
          break;
        case 10:
          value = `\\not{${value}}`;
          break;
        case 11:
          value = `\\overrightarrow{${value}}`;
          break;
        case 12:
          value = `\\overleftarrow{${value}}`;
          break;
        case 13:
          value = `\\overleftrightarrow{${value}}`;
          break;
        case 16:
          value = `\\bar{${value}}`;
          break;
        case 17:
          value = `\\overline{${value}}`;
          break;
        case 18:
          value = `${value}^{\\prime\\prime\\prime}`;
          break;
        case 24:
          value = `\\overset{\\mathinner{\\ldotp\\ldotp\\ldotp\\ldotp}}{${value}}`;
          break;
        case 25:
          value = `\\underset{\\cdot}{${value}}`;
          break;
        case 26:
          value = `\\underset{\\cdot\\cdot}{${value}}`;
          break;
        case 29:
          value = `\\underline{${value}}`;
          break;
        case 30:
          value = `\\underset{\\sim}{${value}}`;
          break;
        case 33:
          value = `\\underset{\\rightarrow}{${value}}`;
          break;
        case 34:
          value = `\\underset{\\leftarrow}{${value}}`;
          break;
        case 35:
          value = `\\underset{\\leftrightarrow}{${value}}`;
          break;
        default:
          this.note(`Unsupported embellishment type ${embellishment} was omitted.`);
      }
    }
    return value;
  }

  private renderMtCode(mtCode: number): string {
    const mapped = LATEX_BY_MTCODE[mtCode];
    if (mapped !== undefined) {
      return mapped;
    }
    if (mtCode >= 0x20 && mtCode <= 0x7e) {
      return escapeLatexMath(String.fromCodePoint(mtCode));
    }

    const character = codePointToText(mtCode);
    if (
      mtCode <= 0x10ffff &&
      !isPrivateUse(mtCode) &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(character)
    ) {
      this.note(`MTCode U+${hexCode(mtCode)} used a Unicode LaTeX fallback.`);
      return `\\mathrm{${escapeLatexText(character)}}`;
    }

    this.note(
      `Unknown MTCode U+${hexCode(mtCode)} was replaced with a visible placeholder.`,
      "low",
    );
    return `\\text{U+${hexCode(mtCode)}}`;
  }

  private renderMatrix(node: MatrixNode): string {
    const expected = node.rows * node.columns;
    if (node.children.length !== expected) {
      this.note(
        `Matrix declared ${expected} cell(s) but contained ${node.children.length}.`,
        "low",
      );
    }
    const cells = node.children.map((child) => this.renderNode(child));
    while (cells.length < expected) {
      cells.push("");
    }
    const rows: string[] = [];
    for (let row = 0; row < node.rows; row += 1) {
      rows.push(
        cells
          .slice(row * node.columns, (row + 1) * node.columns)
          .join("&"),
      );
    }
    return `\\begin{matrix}${rows.join("\\\\")}\\end{matrix}`;
  }

  private renderTemplate(node: TemplateNode): string {
    const slots = node.children.map((child) => this.renderNode(child));
    const slot = (index: number): string => slots[index] ?? "";

    if (node.selector >= 0 && node.selector <= 8) {
      return this.renderFence(node.selector, node.variation, slots);
    }

    switch (node.selector) {
      case 9:
        return this.renderInterval(node.variation, slots);
      case TEMPLATE_ROOT:
        return slot(1)
          ? `\\sqrt[${slot(1)}]{${slot(0)}}`
          : `\\sqrt{${slot(0)}}`;
      case TEMPLATE_FRACTION:
        return `\\frac{${slot(0)}}{${slot(1)}}`;
      case TEMPLATE_UNDERBAR:
        return (node.variation & 1) !== 0
          ? `\\underline{\\underline{${slot(0)}}}`
          : `\\underline{${slot(0)}}`;
      case TEMPLATE_OVERBAR:
        return (node.variation & 1) !== 0
          ? `\\overline{\\overline{${slot(0)}}}`
          : `\\overline{${slot(0)}}`;
      case TEMPLATE_ARROW:
        return this.renderArrow(node.variation, slots);
      case TEMPLATE_INTEGRAL:
      case TEMPLATE_SUM:
      case TEMPLATE_PRODUCT:
      case TEMPLATE_COPRODUCT:
      case TEMPLATE_UNION:
      case TEMPLATE_INTERSECTION:
      case TEMPLATE_INTEGRAL_OPERATOR:
      case TEMPLATE_SUM_OPERATOR:
        return this.renderBigOperator(node.selector, node.variation, slots);
      case TEMPLATE_LIMIT:
        return `\\mathop{${slot(0)}}${slot(2) ? `^{${slot(2)}}` : ""}${
          slot(1) ? `_{${slot(1)}}` : ""
        }`;
      case TEMPLATE_HORIZONTAL_BRACE:
        return (node.variation & 1) !== 0
          ? `\\overbrace{${slot(0)}}^{${slot(1)}}`
          : `\\underbrace{${slot(0)}}_{${slot(1)}}`;
      case TEMPLATE_HORIZONTAL_BRACKET:
        return (node.variation & 1) !== 0
          ? `\\overbracket{${slot(0)}}^{${slot(1)}}`
          : `\\underbracket{${slot(0)}}_{${slot(1)}}`;
      case TEMPLATE_LONG_DIVISION:
        this.note("Long-division layout was approximated in LaTeX.");
        return slot(1)
          ? `\\overline{${slot(1)}\\smash{\\big)}${slot(0)}}`
          : `\\overline{${slot(0)}}`;
      case TEMPLATE_SUBSCRIPT:
      case TEMPLATE_SUPERSCRIPT:
      case TEMPLATE_SUBSUP: {
        const prefix = (node.variation & 1) !== 0 ? "{}" : "";
        const subscript =
          node.selector !== TEMPLATE_SUPERSCRIPT && slot(0)
            ? `_{${slot(0)}}`
            : "";
        const superscript =
          node.selector === TEMPLATE_SUBSCRIPT
            ? slot(1)
              ? `^{${slot(1)}}`
              : ""
            : slot(1)
              ? `^{${slot(1)}}`
              : "";
        return `${prefix}${subscript}${superscript}`;
      }
      case TEMPLATE_DIRAC: {
        const left = (node.variation & 1) !== 0 ? "\\langle " : "";
        const right = (node.variation & 2) !== 0 ? "\\rangle " : "";
        return `${left}${slot(0)}\\mid ${slot(1)}${right}`;
      }
      case TEMPLATE_VECTOR: {
        const under = (node.variation & 4) !== 0;
        const left = (node.variation & 1) !== 0;
        const right = (node.variation & 2) !== 0;
        const harpoon = (node.variation & 8) !== 0;
        const arrow = harpoon
          ? left
            ? "\\leftharpoonup"
            : "\\rightharpoonup"
          : left && right
            ? "\\leftrightarrow"
            : left
              ? "\\leftarrow"
              : "\\rightarrow";
        return under
          ? `\\underset{${arrow}}{${slot(0)}}`
          : left && right
            ? `\\overleftrightarrow{${slot(0)}}`
            : left
              ? `\\overleftarrow{${slot(0)}}`
              : `\\overrightarrow{${slot(0)}}`;
      }
      case TEMPLATE_TILDE:
        return `\\widetilde{${slot(0)}}`;
      case TEMPLATE_HAT:
        return `\\widehat{${slot(0)}}`;
      case TEMPLATE_ARC:
        return `\\overset{\\frown}{${slot(0)}}`;
      case TEMPLATE_JOINT_STATUS:
        this.note("Joint-status template was approximated with an overset.");
        return `\\overset{${slot(1)}}{${slot(0)}}`;
      case TEMPLATE_STRIKE: {
        this.note("Strike-through template was approximated in LaTeX.");
        if ((node.variation & 1) !== 0) {
          return `\\not{${slot(0)}}`;
        }
        return `\\cancel{${slot(0)}}`;
      }
      case TEMPLATE_BOX:
        return `\\boxed{${slot(0)}}`;
      default:
        this.note(
          `Unsupported template selector ${node.selector} was flattened.`,
          "low",
        );
        return slots.join("");
    }
  }

  private renderFence(
    selector: number,
    variation: number,
    slots: readonly string[],
  ): string {
    const defaults: ReadonlyArray<readonly [string, string]> = [
      ["\\langle", "\\rangle"],
      ["(", ")"],
      ["\\{", "\\}"],
      ["[", "]"],
      ["\\vert", "\\vert"],
      ["\\Vert", "\\Vert"],
      ["\\lfloor", "\\rfloor"],
      ["\\lceil", "\\rceil"],
      ["[", "]"],
    ];
    const [defaultLeft, defaultRight] = defaults[selector]!;
    const hasLeft = (variation & 1) !== 0;
    const hasRight = (variation & 2) !== 0;
    const left = hasLeft ? normalizeDelimiter(slots[1], defaultLeft) : ".";
    const right = hasRight ? normalizeDelimiter(slots[2], defaultRight) : ".";
    return `\\left${left} ${slots[0] ?? ""}\\right${right} `;
  }

  private renderInterval(
    variation: number,
    slots: readonly string[],
  ): string {
    const delimiters = ["(", ")", "[", "]"] as const;
    const left = normalizeDelimiter(
      slots[1],
      delimiters[variation & 0x03] ?? "(",
    );
    const right = normalizeDelimiter(
      slots[2],
      delimiters[(variation >>> 4) & 0x03] ?? ")",
    );
    return `\\left${left} ${slots[0] ?? ""}\\right${right} `;
  }

  private renderArrow(
    variation: number,
    slots: readonly string[],
  ): string {
    const actualArrow = slots[slots.length - 1]?.trim();
    let arrow = actualArrow || "\\rightarrow";
    if (!actualArrow) {
      if ((variation & 0x02) !== 0) {
        arrow =
          (variation & 0x10) !== 0 ? "\\leftharpoonup" : "\\rightharpoonup";
      } else if ((variation & 0x01) !== 0) {
        arrow = (variation & 0x10) !== 0 ? "\\Leftarrow" : "\\Rightarrow";
      } else if ((variation & 0x10) !== 0) {
        arrow = "\\leftarrow";
      }
    }
    const annotation = slots[0] ?? "";
    if (!annotation) {
      return `${arrow} `;
    }
    return (variation & 0x08) !== 0
      ? `\\underset{${annotation}}{${arrow}}`
      : `\\overset{${annotation}}{${arrow}}`;
  }

  private renderBigOperator(
    selector: number,
    variation: number,
    slots: readonly string[],
  ): string {
    const defaults: Readonly<Record<number, string>> = {
      [TEMPLATE_INTEGRAL]: integralForVariation(variation),
      [TEMPLATE_SUM]: "\\sum",
      [TEMPLATE_PRODUCT]: "\\prod",
      [TEMPLATE_COPRODUCT]: "\\coprod",
      [TEMPLATE_UNION]: "\\bigcup",
      [TEMPLATE_INTERSECTION]: "\\bigcap",
      [TEMPLATE_INTEGRAL_OPERATOR]: "\\int",
      [TEMPLATE_SUM_OPERATOR]: "\\sum",
    };
    const actualOperator = (slots[3] ?? "").trim();
    const operator = actualOperator || defaults[selector] || "\\mathop{}";
    // MathType's insertion order puts the lower-limit slot before the upper
    // slot in real DSMT7 streams (including null placeholder lines).
    const lower = slots[1] ?? "";
    const upper = slots[2] ?? "";
    const main = slots[0] ?? "";
    return `${operator} ${lower ? `_{${lower}}` : ""}${
      upper ? `^{${upper}}` : ""
    }${main}`;
  }
}

function integralForVariation(variation: number): string {
  switch (variation & 0x0f) {
    case 2:
      return "\\iint";
    case 3:
      return "\\iiint";
    case 4:
    case 8:
    case 12:
      return "\\oint";
    default:
      return "\\int";
  }
}

function normalizeDelimiter(value: string | undefined, fallback: string): string {
  const delimiter = value?.trim();
  if (!delimiter) {
    return fallback;
  }
  const aliases: Readonly<Record<string, string>> = {
    "\\{": "\\{",
    "\\}": "\\}",
    "\\vert": "\\vert",
    "\\Vert": "\\Vert",
    "|": "\\vert",
  };
  return aliases[delimiter] ?? delimiter;
}

function isFunctionLetter(mtCode: number): boolean {
  return (
    (mtCode >= 0x41 && mtCode <= 0x5a) ||
    (mtCode >= 0x61 && mtCode <= 0x7a)
  );
}

function escapeLatexMath(character: string): string {
  const escapes: Readonly<Record<string, string>> = {
    "#": "\\#",
    "$": "\\$",
    "%": "\\%",
    "&": "\\&",
    "\\": "\\backslash ",
    "^": "\\hat{}",
    "_": "\\_",
    "{": "\\{",
    "|": "\\vert ",
    "}": "\\}",
    "~": "\\sim ",
  };
  return escapes[character] ?? character;
}

function escapeLatexText(value: string): string {
  return value.replace(/[#$%&\\^_{}~]/g, (character) => {
    const escapes: Readonly<Record<string, string>> = {
      "#": "\\#",
      "$": "\\$",
      "%": "\\%",
      "&": "\\&",
      "\\": "\\textbackslash{}",
      "^": "\\textasciicircum{}",
      "_": "\\_",
      "{": "\\{",
      "}": "\\}",
      "~": "\\textasciitilde{}",
    };
    return escapes[character]!;
  });
}

function codePointToText(codePoint: number): string {
  if (codePoint < 0 || codePoint > 0x10ffff) {
    return "\ufffd";
  }
  return String.fromCodePoint(codePoint);
}

function isPrivateUse(codePoint: number): boolean {
  return (
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

function hexCode(codePoint: number): string {
  return codePoint.toString(16).toUpperCase().padStart(4, "0");
}

function extractMtefStream(
  oleBuffer: Buffer,
): { stream: Buffer; warning?: string } {
  if (!Buffer.isBuffer(oleBuffer) || oleBuffer.length < 512) {
    throw new Error("Input is not a complete OLE Compound File buffer");
  }
  const oleMagic = "d0cf11e0a1b11ae1";
  if (oleBuffer.subarray(0, 8).toString("hex") !== oleMagic) {
    throw new Error("Input does not have an OLE Compound File signature");
  }

  const cfb = XLSX.CFB.read(oleBuffer, {
    type: "buffer",
  }) as CfbContainer;
  const streamIndex = cfb.FullPaths.findIndex((path) =>
    /\/Equation Native$/i.test(path.replace(/\\/g, "/")),
  );
  if (streamIndex < 0) {
    throw new Error('OLE object does not contain an "Equation Native" stream');
  }
  const content = cfb.FileIndex[streamIndex]?.content;
  if (content === undefined) {
    throw new Error('"Equation Native" stream has no content');
  }
  const nativeStream =
    typeof content === "string"
      ? Buffer.from(content, "binary")
      : Buffer.from(content);
  if (nativeStream.length < 12) {
    throw new Error('"Equation Native" stream is too short');
  }

  const headerLength = nativeStream.readUInt32LE(0);
  const declaredMtefLength = nativeStream.readUInt32LE(8);
  if (headerLength < 12 || headerLength > nativeStream.length) {
    throw new Error(
      `Invalid Equation Native header length ${headerLength}`,
    );
  }
  const available = nativeStream.length - headerLength;
  if (declaredMtefLength > available) {
    throw new Error(
      `Equation Native declares ${declaredMtefLength} MTEF bytes but only ${available} are available`,
    );
  }
  if (declaredMtefLength === 0) {
    throw new Error("Equation Native contains an empty MTEF stream");
  }

  return {
    stream: nativeStream.subarray(
      headerLength,
      headerLength + declaredMtefLength,
    ),
    warning:
      declaredMtefLength < available
        ? `Ignored ${available - declaredMtefLength} byte(s) after the declared MTEF stream.`
        : undefined,
  };
}

/**
 * Converts a MathType OLE Equation Native stream to LaTeX.
 *
 * The implementation follows the published MTEF v5 record specification.
 * It deliberately returns an explicit low-confidence failure instead of
 * silently dropping malformed or unsupported equations.
 */
export function convertMathTypeOleToLatex(
  buffer: Buffer,
): MtefConversionResult {
  try {
    const extracted = extractMtefStream(buffer);
    const parser = new MtefParser(new BinaryReader(extracted.stream));
    if (extracted.warning) {
      parser.addExternalWarning(extracted.warning);
    }
    return parser.parse();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      latex: "",
      confidence: "low",
      warnings: [`MathType OLE/MTEF conversion failed: ${message}`],
    };
  }
}
