import type { GridGuideDocument, TechLandscape } from './types';

function stripDiskAndCorpusPaths(value: string) {
  return value
    .replace(/(?:storage|knowledge-corpus)[\\/][^，。；\s]+/g, '')
    .replace(/[A-Za-z]:[\\/][^，。；\s]+/g, (match, offset: number, full: string) => {
      // 避免把 https:// 或 http:// 里的 s:/、p:/ 当成 Windows 盘符
      if (offset > 0 && /[A-Za-z]/i.test(full.charAt(offset - 1))) return match;
      return '';
    });
}

/** 去掉联网/语料引用痕迹，避免正式指南正文出现 [http、URL、路径等奇怪残留。 */
export function cleanGridGuideFormalText(value: string) {
  let text = value
    .replace(/(?:导师|专家)\s*[0-9a-f]{8,}[^；。\n]*(?:[；。]|$)/gi, '')
    .replace(/【[^】]*(?:†|来源|引用|文献|文件|知识语料)[^】]*】/g, '')
    .replace(/[［[]\s*知识语料[^］\]]*[］\]]/gi, '')
    .replace(/(?:文献|论文|资料|文件|数据记录)\s*[［[][^［\][\]]+[］\]]/g, '')
    .replace(/(?:导师|专家)\s*[0-9a-f]{8,}/gi, '')
    .replace(/[［[]\s*[0-9a-f]{8,}(?:[-_][0-9a-z]+)*\s*[］\]]/gi, '')
    .replace(/\b[0-9a-f]{20,}\b/gi, '')
    .replace(/(?:来源|参见|引自)\s*[：:]\s*[^。；\n]+[。；]?/g, '');

  // 先清 URL / 链接，再清路径
  text = text
    .replace(/\[([^\]]{0,200})\]\(\s*https?:\/\/[^)]*\)/gi, '$1')
    .replace(/[\[［]\s*https?:\/\/[^\]］]*[\]］]/gi, '')
    .replace(/[\[［]\s*https?:\/\/[^\]］\s，。；、)）]*/gi, '')
    .replace(/[\[［]\s*https?(?![a-z])/gi, '')
    .replace(/https?:\/\/[^\s\]］）)，,。；;<>"']+/gi, '')
    .replace(/\bwww\.[^\s\]］）)，,。；;<>"']+/gi, '');

  text = stripDiskAndCorpusPaths(text);

  return text
    .replace(/[\[［]\s*[\]］]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([，。；：])/g, '$1')
    .replace(/([，。；：]){2,}/g, '$1')
    .replace(/^[，；：、\s]+/gm, '')
    .trim();
}

function cleanValue<T>(value: T): T {
  if (typeof value === 'string') return cleanGridGuideFormalText(value) as T;
  if (Array.isArray(value)) return value.map((item) => cleanValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cleanValue(item)])
    ) as T;
  }
  return value;
}

function cleanTechLandscape(landscape?: TechLandscape): TechLandscape | undefined {
  if (!landscape) return undefined;
  return {
    overview: cleanGridGuideFormalText(landscape.overview || ''),
    existingInCorpus: (landscape.existingInCorpus || []).map((item) => ({
      title: cleanGridGuideFormalText(item.title || ''),
      gist: cleanGridGuideFormalText(item.gist || ''),
      gapOrDifference: item.gapOrDifference
        ? cleanGridGuideFormalText(item.gapOrDifference)
        : undefined,
      sourceLabel: item.sourceLabel ? cleanGridGuideFormalText(item.sourceLabel) : undefined
    })),
    latestOnline: (landscape.latestOnline || []).map((item) => ({
      title: cleanGridGuideFormalText(item.title || ''),
      gist: cleanGridGuideFormalText(item.gist || ''),
      gapOrDifference: item.gapOrDifference
        ? cleanGridGuideFormalText(item.gapOrDifference)
        : undefined,
      sourceLabel: item.sourceLabel ? cleanGridGuideFormalText(item.sourceLabel) : undefined,
      url: item.url?.trim() || undefined
    })),
    differentiations: (landscape.differentiations || []).map((item) => ({
      proposedInnovation: cleanGridGuideFormalText(item.proposedInnovation || ''),
      differenceFromExisting: cleanGridGuideFormalText(item.differenceFromExisting || ''),
      differenceFromLatest: cleanGridGuideFormalText(item.differenceFromLatest || '')
    }))
  };
}

export function sanitizeGridGuideFormalReferences(
  document: GridGuideDocument
): GridGuideDocument {
  return {
    ...document,
    projectTitle: cleanGridGuideFormalText(document.projectTitle),
    guide: cleanValue(document.guide),
    explanation: cleanValue(document.explanation),
    evidenceSummary: (document.evidenceSummary || []).map((item) => cleanGridGuideFormalText(item)),
    techLandscape: cleanTechLandscape(document.techLandscape)
  };
}
