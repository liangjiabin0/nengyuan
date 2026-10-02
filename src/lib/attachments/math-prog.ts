/** Shared MPS / LP helpers. Keep extracted text short — production models can be huge. */

export const MATH_PROG_EXTENSIONS = ['.mps', '.lp'] as const;

export type MathProgSummary = {
  format: 'mps' | 'lp';
  name: string;
  rows: number;
  columns: number;
  integerColumns: number;
  byteLength: number;
  text: string;
};

export function isMathProgExtension(extension: string) {
  return extension === '.mps' || extension === '.lp';
}

export function isMathProgPath(filePath: string) {
  return isMathProgExtension(filePath.replace(/\\/g, '/').toLowerCase().slice(filePath.lastIndexOf('.')));
}

function firstToken(line: string) {
  return line.trim().split(/\s+/, 1)[0] || '';
}

function summarizeMps(text: string, fileName: string, byteLength: number): MathProgSummary {
  const lines = text.split(/\r?\n/);
  let name = fileName.replace(/\.[^.]+$/, '') || 'model';
  let section = '';
  let rows = 0;
  let integerColumns = 0;
  const columns = new Set<string>();

  for (const raw of lines) {
    if (!raw || raw[0] === '*' || raw[0] === '$') continue;
    const head = raw.slice(0, 7).toUpperCase();
    if (head.startsWith('NAME')) {
      const rest = raw.slice(4).trim();
      if (rest) name = rest.split(/\s+/, 1)[0] || name;
      continue;
    }
    if (
      head.startsWith('ROWS')
      || head.startsWith('COLUMNS')
      || head.startsWith('RHS')
      || head.startsWith('BOUNDS')
      || head.startsWith('RANGES')
      || head.startsWith('ENDATA')
    ) {
      section = firstToken(raw).toUpperCase();
      continue;
    }
    if (section === 'ROWS') {
      const sense = raw.trim()[0]?.toUpperCase();
      if (sense && 'NELG'.includes(sense)) rows += 1;
    } else if (section === 'COLUMNS') {
      const trimmed = raw.trim();
      if (/^INTORG$/i.test(trimmed) || /MARKER/i.test(trimmed) && /INTORG/i.test(trimmed)) {
        integerColumns += 1;
        continue;
      }
      if (/^INTEND$/i.test(trimmed) || /MARKER/i.test(trimmed)) continue;
      const col = firstToken(raw.slice(0, 14).trim() ? raw.slice(0, 14) : raw);
      if (col && col !== "'MARKER'") columns.add(col);
    }
  }

  const format = 'mps' as const;
  const textOut = [
    `MPS 线性规划模型（${name}，${byteLength} 字节）。`,
    `约束行 ${rows}，决策列约 ${columns.size}${integerColumns ? `，含整数段标记 ${integerColumns}` : ''}。`,
    '此文件供 ESOPT / HiGHS 直接读取，不展开全部矩阵。',
    '',
    '识别到的文件头：',
    ...lines.slice(0, 8).map((line) => line.replace(/\s+$/, ''))
  ].join('\n');

  return {
    format,
    name,
    rows,
    columns: columns.size,
    integerColumns,
    byteLength,
    text: textOut
  };
}

function summarizeLp(text: string, fileName: string, byteLength: number): MathProgSummary {
  const lines = text.split(/\r?\n/);
  const nameMatch = text.match(/\\?\s*Problem name:\s*(\S+)/i) || text.match(/Minimize|Maximize/i);
  const name = (nameMatch && nameMatch[1]) || fileName.replace(/\.[^.]+$/, '') || 'model';
  const rows = (text.match(/\n\s*subject to|\n\s*s\.t\.|\n\s*[A-Za-z_]\w*\s*:/gi) || []).length;
  const columns = (text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []).length;
  const textOut = [
    `LP 线性规划模型（${name}，${byteLength} 字节）。`,
    '此文件供 ESOPT / HiGHS 直接读取，不展开全部矩阵。',
    '',
    ...lines.slice(0, 12).map((line) => line.replace(/\s+$/, ''))
  ].join('\n');
  return {
    format: 'lp',
    name,
    rows,
    columns,
    integerColumns: /integer|binary|general/i.test(text) ? 1 : 0,
    byteLength,
    text: textOut
  };
}

export function summarizeMathProg(buffer: Buffer, extension: string, fileName = 'model') {
  const text = buffer.toString('latin1');
  return extension === '.lp'
    ? summarizeLp(text, fileName, buffer.length)
    : summarizeMps(text, fileName, buffer.length);
}
