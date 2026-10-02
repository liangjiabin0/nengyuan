/** 将 PDF 全文切分为正文 / 参考文献 / 附录，避免参考文献污染检索索引 */

const REF_START = /(?:^|\n)\s*(参考文献|REFERENCES|References)\s*[:：]?\s*(?:\n|$)/i;
const TAIL_START = /(?:^|\n)\s*(作者简介|作者简历|致谢|Acknowledgment|Appendix|附录)\s*[:：]?\s*(?:\n|$)/i;

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseReferenceEntries(section: string) {
  if (!section.trim()) return [] as string[];
  const cleaned = section
    .replace(/^(参考文献|REFERENCES|References)\s*[:：]?\s*/i, '')
    .trim();

  const byNumber = cleaned
    .split(/\n(?=\s*(?:\[\d+\]|\d+[\.．、]\s*))/g)
    .map((item) => normalizeWhitespace(item.replace(/^\s*(?:\[\d+\]|\d+[\.．、])\s*/, '')))
    .filter((item) => item.length > 12);

  if (byNumber.length > 1) return byNumber.slice(0, 200);

  return cleaned
    .split(/\[\d+\]/g)
    .map(normalizeWhitespace)
    .filter((item) => item.length > 12)
    .slice(0, 200);
}

export type PaperSegments = {
  bodyText: string;
  referencesText: string;
  tailText: string;
  referenceEntries: string[];
};

export function segmentPaperText(rawText: string): PaperSegments {
  const text = normalizeWhitespace(rawText);
  if (!text) {
    return { bodyText: '', referencesText: '', tailText: '', referenceEntries: [] };
  }

  const refMatch = REF_START.exec(text);
  const refIndex = refMatch && refMatch.index >= Math.floor(text.length * 0.25) ? refMatch.index : -1;

  let bodyText = text;
  let referencesText = '';
  let tailText = '';

  if (refIndex >= 0) {
    bodyText = text.slice(0, refIndex).trim();
    const afterRef = text.slice(refIndex).trim();
    const tailMatch = TAIL_START.exec(afterRef);
    if (tailMatch && tailMatch.index > 80) {
      referencesText = afterRef.slice(0, tailMatch.index).trim();
      tailText = afterRef.slice(tailMatch.index).trim();
    } else {
      referencesText = afterRef;
    }
  }

  const referenceEntries = parseReferenceEntries(referencesText);

  return { bodyText, referencesText, tailText, referenceEntries };
}

export function isReferenceLikeParagraph(paragraph: string) {
  const p = paragraph.trim();
  if (p.length < 20) return false;
  if (/^(参考文献|REFERENCES|References)\s*[:：]?$/i.test(p)) return true;
  if (/^\[\d+\]\s+.{10,}/.test(p)) return true;
  if (/^\d+[\.．、]\s+[A-Z\u4e00-\u9fa5].{15,}/.test(p)) return true;
  if (/\d{4}[;；,，]\s*\d+\(\d+\)/.test(p) && p.length > 40) return true;
  return false;
}
