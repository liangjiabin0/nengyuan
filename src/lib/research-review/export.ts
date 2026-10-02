import {
  AlignmentType,
  BorderStyle,
  convertMillimetersToTwip,
  Document,
  Footer,
  HeadingLevel,
  Math as OmmlMath,
  MathRun,
  MathSubScript,
  MathSuperScript,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableBorders,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild
} from 'docx';

const EAST_ASIA = '宋体';
const LATIN = 'Times New Roman';
/** Codex 参考稿与 inspect 脚本均以宋体+加粗承载标题（非黑体）。 */
const HEADING_EAST = '宋体';
const BODY_SIZE = 24; // 小四 = 12pt
const LINE_150 = 360; // 1.5 倍（240=单倍）

type RunOpts = {
  bold?: boolean;
  size?: number;
  eastAsia?: string;
  superScript?: boolean;
  italics?: boolean;
  color?: string;
};

function fontFace(eastAsia = EAST_ASIA): NonNullable<IRunOptions['font']> {
  return {
    ascii: LATIN,
    hAnsi: LATIN,
    eastAsia,
    cs: LATIN
  };
}

function textRun(text: string, options: RunOpts = {}) {
  return new TextRun({
    text,
    bold: options.bold,
    italics: options.italics,
    size: options.size || BODY_SIZE,
    font: fontFace(options.eastAsia || EAST_ASIA),
    superScript: options.superScript,
    color: options.color || '000000'
  });
}

/** Strip agent process chatter and markdown noise before export. */
export function prepareResearchReviewMarkdown(content: string) {
  let text = String(content || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!text) return text;

  // Drop leading meta / process blocks until a real title/heading/摘要.
  const blocks = text.split(/\n{2,}/);
  let start = 0;
  while (start < blocks.length) {
    const block = blocks[start].trim();
    if (!block) {
      start += 1;
      continue;
    }
    const isTitleLike =
      /^#{1,3}\s+\S/.test(block)
      || /^(摘要|关键词|目录|参考文献|附录|编制说明)\b/.test(block)
      || /^[一二三四五六七八九十]+[、.．]/.test(block)
      || /^\d+(\.\d+)*\s+\S/.test(block);
    const isMeta =
      /^(我将|我先|现在|接下来|首先|然后|让我|我已经|根据系统|路径不对|workdir|技能|读取)/i.test(block)
      || /加载\s*skill|证据边界|工作区|INDEX\.md|按索引|开始撰写综述正文|组织以下内容/i.test(block)
      || (/^\s*[-*]\s+\*\*/.test(block) && /Bhusal|Stankovic|研究缺口/.test(block));
    if (isTitleLike && !isMeta) break;
    if (!isMeta && !/^---+$/.test(block) && block.length > 40) break;
    start += 1;
  }
  text = blocks.slice(start).join('\n\n').trim() || text;

  return text
    .replace(/^---+\s*$/gm, '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, ''))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[E\d+\]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseSimpleLatex(latex: string): ParagraphChild | null {
  const raw = latex.trim();
  if (!raw) return null;

  // E_{sh} / T_D / P_{peak}
  const sub = raw.match(/^([A-Za-z\\]+)_\{([A-Za-z0-9]+)\}$/) || raw.match(/^([A-Za-z\\]+)_([A-Za-z0-9]+)$/);
  if (sub) {
    const base = sub[1].replace(/^\\/, '');
    return new OmmlMath({
      children: [
        new MathSubScript({
          children: [new MathRun(base)],
          subScript: [new MathRun(sub[2])]
        })
      ]
    });
  }

  const sup = raw.match(/^([A-Za-z\\]+)\^\{([A-Za-z0-9]+)\}$/) || raw.match(/^([A-Za-z\\]+)\^([A-Za-z0-9]+)$/);
  if (sup) {
    const base = sup[1].replace(/^\\/, '');
    return new OmmlMath({
      children: [
        new MathSuperScript({
          children: [new MathRun(base)],
          superScript: [new MathRun(sup[2])]
        })
      ]
    });
  }

  // X/R or plain identifier
  if (/^[A-Za-z0-9\\/\-\s]+$/.test(raw) && raw.length <= 24) {
    return new OmmlMath({
      children: [new MathRun(raw.replace(/\\/g, ''))]
    });
  }

  return null;
}

function citationToSuperscript(token: string): TextRun {
  const inner = token.replace(/^[\[［]/, '').replace(/[\]］]$/, '').replace(/\s+/g, '');
  return textRun(inner, { superScript: true, size: 18 });
}

function splitInlineChildren(text: string): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  // Order: display/inline math, then citation brackets (incl. ranges/commas), then plain
  const pattern =
    /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|[\[［]\s*\d+(?:\s*[-–—,，]\s*\d+)*\s*[\]］])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      children.push(textRun(text.slice(last, match.index)));
    }
    const token = match[0];
    if (token.startsWith('$$') && token.endsWith('$$')) {
      const math = parseSimpleLatex(token.slice(2, -2));
      children.push(math || textRun(token.slice(2, -2)));
    } else if (token.startsWith('$') && token.endsWith('$')) {
      const math = parseSimpleLatex(token.slice(1, -1));
      children.push(math || textRun(token.slice(1, -1)));
    } else {
      children.push(citationToSuperscript(token));
    }
    last = match.index + token.length;
  }
  if (last < text.length) children.push(textRun(text.slice(last)));
  return children.length ? children : [textRun('')];
}

function bodyParagraph(text: string) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: convertMillimetersToTwip(7.4) }, // ~2 字符
    spacing: { line: LINE_150, after: 60 },
    children: splitInlineChildren(text)
  });
}

function headingParagraph(text: string, level: 1 | 2 | 3) {
  const heading =
    level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
  const size = level === 1 ? 32 : level === 2 ? 28 : 24; // 三号 / 四号 / 小四
  return new Paragraph({
    heading,
    spacing: {
      before: level === 1 ? 240 : 160,
      after: level === 1 ? 120 : 80,
      line: LINE_150
    },
    children: [
      textRun(text, {
        bold: true,
        size,
        eastAsia: HEADING_EAST,
        color: '000000'
      })
    ]
  });
}

function formatChineseDate(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function titleParagraph(text: string) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 280, line: LINE_150 },
    children: [textRun(text, { bold: true, size: 36, eastAsia: HEADING_EAST })]
  });
}

function metaParagraph(text: string) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 40, line: LINE_150 },
    children: [textRun(text, { size: 21 })]
  });
}

function referenceParagraph(text: string) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { left: convertMillimetersToTwip(7.4), hanging: convertMillimetersToTwip(7.4) },
    spacing: { line: LINE_150, after: 40 },
    children: splitInlineChildren(text)
  });
}

function isReferenceLine(text: string) {
  return /^(\[\d+\]|\d+\.?)\s+\S/.test(text.trim());
}

function isHeadingLine(line: string) {
  return /^(#{1,3})\s+(.+)$/.exec(line.trim());
}

function numberedHeading(line: string): { level: 1 | 2 | 3; text: string } | null {
  const m = /^(\d+(?:\.\d+){0,2})\s+(.+)$/.exec(line.trim());
  if (!m) return null;
  const depth = m[1].split('.').length as 1 | 2 | 3;
  if (depth > 3) return null;
  // Avoid treating references like "2024 ..." as headings
  if (/^\d{4}\b/.test(m[1])) return null;
  return { level: depth, text: `${m[1]} ${m[2].trim()}` };
}

/** Codex 体例常见短标题：难点1：… / 研究内容3：… */
function namedItemHeading(line: string): { level: 1 | 2 | 3; text: string } | null {
  const trimmed = line.trim();
  if (/^(难点|研究内容|方向)\s*\d+\s*[:：]/.test(trimmed) && trimmed.length <= 80) {
    return { level: 3, text: trimmed };
  }
  if (/^摘\s*要$/.test(trimmed)) return { level: 1, text: '摘  要' };
  if (/^(目录与结构说明|参考文献|编制说明)$/.test(trimmed)) {
    return { level: 1, text: trimmed };
  }
  return null;
}

function normalizeSectionHeading(text: string, level: 1 | 2 | 3): { text: string; level: 1 | 2 | 3 } {
  if (/^摘\s*要$/.test(text)) return { text: '摘  要', level: 1 };
  if (/^(目录与结构说明|参考文献|编制说明)$/.test(text)) return { text, level: 1 };
  if (/^(难点|研究内容)\s*\d+\s*[:：]/.test(text)) return { text, level: 3 };
  return { text, level };
}

function parseMarkdownTable(lines: string[]): Table | null {
  if (lines.length < 2 || !lines.every((line) => line.includes('|'))) return null;
  const rows = lines
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, ''))
    .filter((line) => !/^\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*$/.test(line))
    .map((line) => line.split('|').map((cell) => cell.trim()));
  if (rows.length < 1) return null;

      const colCount = globalThis.Math.max(...rows.map((row) => row.length));
    const tableRows = rows.map((row, rowIndex) => {
    const cells = Array.from({ length: colCount }, (_, i) => row[i] || '');
    return new TableRow({
      children: cells.map(
        (cell) =>
          new TableCell({
            width: { size: globalThis.Math.floor(9000 / colCount), type: WidthType.DXA },
            borders: {
              top: {
                style: rowIndex === 0 ? BorderStyle.SINGLE : BorderStyle.NIL,
                size: rowIndex === 0 ? 12 : 0,
                color: '000000'
              },
              bottom: {
                style:
                  rowIndex === 0 || rowIndex === rows.length - 1
                    ? BorderStyle.SINGLE
                    : BorderStyle.NIL,
                size: rowIndex === 0 ? 8 : rowIndex === rows.length - 1 ? 12 : 0,
                color: '000000'
              },
              left: { style: BorderStyle.NIL, size: 0, color: '000000' },
              right: { style: BorderStyle.NIL, size: 0, color: '000000' }
            },
            children: [
              new Paragraph({
                alignment: rowIndex === 0 ? AlignmentType.CENTER : AlignmentType.LEFT,
                spacing: { line: 276, after: 0 },
                children: [textRun(cell, { bold: rowIndex === 0, size: 21 })]
              })
            ]
          })
      )
    });
  });

  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    // 清除默认网格线；三线表仅由单元格 top/bottom 控制
    borders: TableBorders.NONE,
    rows: tableRows
  });
}

function extractTitle(lines: string[], fallback: string) {
  for (const line of lines) {
    const h = isHeadingLine(line);
    if (h && h[1].length === 1) return h[2].trim();
    if (/^复杂场景|^微网|^配电网|^研究综述/.test(line.trim()) && line.trim().length < 80) {
      return line.trim().replace(/^#+\s*/, '');
    }
  }
  return fallback;
}

export async function buildResearchReviewDocx(content: string, title = '科研综述') {
  const markdown = prepareResearchReviewMarkdown(content);
  const lines = markdown.split('\n');
  const docTitle = extractTitle(lines, title);

  const children: Array<Paragraph | Table> = [
    titleParagraph(docTitle),
    metaParagraph('文献综述、关键难点、研究内容与解决思路（技术路线）'),
    metaParagraph('文献范围：用户上传文献证据包'),
    metaParagraph(`编制日期：${formatChineseDate(new Date())}`)
  ];

  let inReferences = false;
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Skip duplicate H1 matching document title
    const headingMatch = isHeadingLine(trimmed);
    if (headingMatch) {
      const level = globalThis.Math.min(3, headingMatch[1].length) as 1 | 2 | 3;
      const headingText = headingMatch[2].trim();
      if (
        level === 1
        && (headingText === docTitle
          || (/研究综述|技术路线/.test(headingText)
            && docTitle.length >= 8
            && headingText.includes(docTitle.slice(0, 8))))
      ) {
        i += 1;
        continue;
      }
      if (/^参考文献/.test(headingText)) inReferences = true;
      const normalized = normalizeSectionHeading(headingText, level);
      children.push(headingParagraph(normalized.text, normalized.level));
      i += 1;
      continue;
    }

    if (/^参考文献\s*$/.test(trimmed)) {
      inReferences = true;
      children.push(headingParagraph('参考文献', 1));
      i += 1;
      continue;
    }

    if (/^关键词\s*[:：]/.test(trimmed)) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { before: 80, after: 160, line: LINE_150 },
          children: [textRun(trimmed, { size: 21 })]
        })
      );
      i += 1;
      continue;
    }

    // Markdown table block（允许表题在上一行）
    if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i += 1;
      }
      const table = parseMarkdownTable(tableLines);
      if (table) {
        children.push(table);
        children.push(
          new Paragraph({
            spacing: { after: 120 },
            children: [textRun('')]
          })
        );
      }
      continue;
    }

    if (/^表\s*\d+/.test(trimmed) && trimmed.length <= 60) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 120, after: 40, line: LINE_150 },
          children: [textRun(trimmed, { size: 21 })]
        })
      );
      i += 1;
      continue;
    }

    const named = namedItemHeading(trimmed);
    if (named && !inReferences) {
      children.push(headingParagraph(named.text, named.level));
      i += 1;
      continue;
    }

    const numbered = numberedHeading(trimmed);
    if (numbered && !inReferences && !isReferenceLine(trimmed)) {
      children.push(headingParagraph(numbered.text, numbered.level));
      i += 1;
      continue;
    }

    if (inReferences || isReferenceLine(trimmed)) {
      inReferences = true;
      children.push(referenceParagraph(trimmed.replace(/^(\d+)\.\s+/, '[$1] ')));
      i += 1;
      continue;
    }

    // ○ / bullet — Codex 体例常用分条证据句
    if (/^[○●•·]\s*/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^（?\d+）/.test(trimmed)) {
      const body = trimmed
        .replace(/^[-*]\s+/, '○ ')
        .replace(/^[●•·]\s*/, '○ ');
      children.push(
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          indent: { left: convertMillimetersToTwip(7.4) },
          spacing: { line: LINE_150, after: 40 },
          children: splitInlineChildren(body)
        })
      );
      i += 1;
      continue;
    }

    children.push(bodyParagraph(trimmed));
    i += 1;
  }

  if (children.length <= 3) {
    children.push(bodyParagraph(markdown || '（空正文）'));
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: fontFace(),
            size: BODY_SIZE,
            color: '000000'
          },
          paragraph: {
            spacing: { line: LINE_150 }
          }
        }
      },
      paragraphStyles: [
        {
          id: 'Heading1',
          name: 'Heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          paragraph: {
            spacing: { before: 240, after: 120, line: LINE_150 }
          },
          run: {
            bold: true,
            size: 32,
            font: fontFace(HEADING_EAST),
            color: '000000'
          }
        },
        {
          id: 'Heading2',
          name: 'Heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          paragraph: {
            spacing: { before: 160, after: 80, line: LINE_150 }
          },
          run: {
            bold: true,
            size: 28,
            font: fontFace(HEADING_EAST),
            color: '000000'
          }
        },
        {
          id: 'Heading3',
          name: 'Heading 3',
          basedOn: 'Normal',
          next: 'Normal',
          paragraph: {
            spacing: { before: 120, after: 60, line: LINE_150 }
          },
          run: {
            bold: true,
            size: 24,
            font: fontFace(HEADING_EAST),
            color: '000000'
          }
        }
      ]
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertMillimetersToTwip(25),
              bottom: convertMillimetersToTwip(25),
              left: convertMillimetersToTwip(30),
              right: convertMillimetersToTwip(25)
            }
          }
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: fontFace(),
                    size: 18,
                    color: '000000'
                  })
                ]
              })
            ]
          })
        },
        children
      }
    ]
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

export function researchReviewFileName(title: string) {
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${safe || '科研综述'}.docx`;
}
