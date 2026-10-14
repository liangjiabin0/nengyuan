import fs from 'node:fs';
import path from 'node:path';

/**
 * 论文文本抽取：PDF 用 pdf-parse 逐页取文本，DOCX 用 mammoth，LaTeX/TXT/MD 直接读。
 * 产出带页码标记的全文，便于模型引用“第 N 页 / 第 X 节”。抽取失败如实返回原因，
 * 不把“没抽到”当成“论文里没有”。
 */
export type ParsedPaper = {
  format: 'pdf' | 'docx' | 'tex' | 'text';
  pageCount: number;
  chars: number;
  text: string;
  pages: string[];
  language: 'zh' | 'en';
  warnings: string[];
};

function detectLanguage(text: string): 'zh' | 'en' {
  const sample = text.slice(0, 20_000);
  const cjk = (sample.match(/[一-鿿]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  return cjk > latin * 0.15 ? 'zh' : 'en';
}

function clean(value: string) {
  return value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

export async function parsePaperFile(file: string): Promise<ParsedPaper> {
  const ext = path.extname(file).toLowerCase();
  const buffer = fs.readFileSync(file);
  const warnings: string[] = [];
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const raw = result as unknown as { text?: string; pages?: Array<{ text?: string; num?: number }>; total?: number };
      const pages = (raw.pages?.length ? raw.pages.map((p) => clean(p.text || '')) : [clean(raw.text || '')]);
      const text = pages.map((p, i) => `\n\n=== 第 ${i + 1} 页 ===\n${p}`).join('').trim();
      if (text.replace(/=== 第 \d+ 页 ===/g, '').trim().length < 200) {
        warnings.push('PDF 只抽取到很少文字，可能是扫描版（当前不做 OCR）；评审时必须说明正文无法完整读取。');
      }
      return { format: 'pdf', pageCount: Number(raw.total || pages.length), chars: text.length, text, pages, language: detectLanguage(text), warnings };
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    const text = clean(result.value);
    if (result.messages.length) warnings.push(...result.messages.slice(0, 5).map((m) => `DOCX：${m.message}`));
    warnings.push('DOCX 抽取不保留页码，引用位置以章节/公式/表格编号为准。');
    return { format: 'docx', pageCount: 0, chars: text.length, text, pages: [text], language: detectLanguage(text), warnings };
  }
  if (['.tex', '.txt', '.md', '.markdown'].includes(ext)) {
    const text = clean(buffer.toString('utf8'));
    return { format: ext === '.tex' ? 'tex' : 'text', pageCount: 0, chars: text.length, text, pages: [text], language: detectLanguage(text), warnings };
  }
  throw new Error(`不支持的论文格式：${ext}（支持 PDF、DOCX、TEX、TXT、MD）`);
}

/** 按字符预算切片；超长论文分块送模型，而不是截掉后半部分。 */
export function chunkText(text: string, maxChars = 120_000) {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    const pageBreak = text.lastIndexOf('\n=== 第 ', end);
    if (pageBreak > start + maxChars * 0.5) end = pageBreak;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
