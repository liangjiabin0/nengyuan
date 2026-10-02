import { searchRecords, type SearchResult } from '@/lib/search-index';
import type {
  InventionDisclosure,
  PriorArtCandidate,
  PriorArtReport
} from './types';

const STOP_TERMS = new Set([
  '一种',
  '方法',
  '系统',
  '装置',
  '模型',
  '进行',
  '用于',
  '基于',
  '考虑',
  '通过',
  '实现',
  '优化',
  '数据'
]);

function terms(value: string) {
  const chinese = value.match(/[\u3400-\u9fff]{2,8}/g) || [];
  const latin = value.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [];
  const output = new Set<string>();
  for (const token of [...chinese, ...latin]) {
    const normalized = token.trim();
    if (normalized.length >= 2 && !STOP_TERMS.has(normalized)) output.add(normalized);
  }
  return [...output];
}

function featureTerms(disclosure: InventionDisclosure) {
  const weighted = disclosure.essentialFeatures.flatMap((feature) => [
    feature.name,
    feature.description,
    feature.technicalEffect
  ]);
  return terms([
    disclosure.proposedTitle,
    disclosure.technicalField,
    disclosure.inventiveConcept,
    ...weighted
  ].join(' ')).slice(0, 30);
}

export function buildPriorArtQueries(disclosure: InventionDisclosure) {
  const coreTerms = featureTerms(disclosure);
  const featureNames = disclosure.essentialFeatures.map((feature) => feature.name).filter(Boolean);
  const queries = [
    disclosure.proposedTitle,
    featureNames.slice(0, 3).join(' '),
    featureNames.slice(1, 5).join(' '),
    [disclosure.technicalField, ...coreTerms.slice(0, 5)].join(' ')
  ]
    .map((query) => query.replace(/\s+/g, ' ').trim())
    .filter((query) => query.length >= 4);
  return [...new Set(queries)].slice(0, 5);
}

function publicationNumber(result: SearchResult) {
  const content = `${result.title}\n${result.body}\n${JSON.stringify(result.fields)}`;
  return /\bCN[-_]?\d{6,}[A-Z]?\b/i.exec(content)?.[0]?.replace(/_/g, '-') || undefined;
}

function sourceUrl(result: SearchResult) {
  const value = String(
    result.fields.source_url
    || result.fields.url
    || result.fields.previewUrl
    || ''
  ).trim();
  if (/^https?:\/\//i.test(value)) return value;
  const bodyUrl = /https?:\/\/patents\.google\.com\/patent\/[A-Z0-9-]+/i.exec(result.body)?.[0];
  return bodyUrl || undefined;
}

function candidateFromResult(
  result: SearchResult,
  disclosure: InventionDisclosure,
  coreTerms: string[]
): PriorArtCandidate {
  const haystack = `${result.title} ${result.snippet} ${result.body.slice(0, 5_000)}`.toLowerCase();
  const matched = coreTerms.filter((term) => haystack.includes(term.toLowerCase()));
  const commonFeatures = disclosure.essentialFeatures
    .filter((feature) => {
      const tokens = terms(`${feature.name} ${feature.description}`);
      return tokens.some((token) => haystack.includes(token.toLowerCase()));
    })
    .map((feature) => feature.name);
  const distinguishingFeatures = disclosure.essentialFeatures
    .filter((feature) => !commonFeatures.includes(feature.name))
    .map((feature) => feature.name);
  const overlap = coreTerms.length ? matched.length / coreTerms.length : 0;
  const risk: PriorArtCandidate['risk'] = overlap >= 0.4 || commonFeatures.length >= 3
    ? 'high'
    : overlap >= 0.2 || commonFeatures.length >= 2
      ? 'medium'
      : 'low';
  return {
    id: result.sourceKey,
    title: result.title.replace(/\s*·\s*专利全文$/, ''),
    publicationNumber: publicationNumber(result),
    applicant: String(result.fields.authors || result.fields.applicant || '').trim() || undefined,
    date: String(result.fields.pub_date || result.fields.date || '').trim() || undefined,
    url: sourceUrl(result),
    snippet: result.snippet || result.body.replace(/\s+/g, ' ').slice(0, 600),
    score: Number(result.score || 0),
    commonFeatures,
    distinguishingFeatures,
    risk,
    riskReason: matched.length
      ? `检索文本与 ${matched.slice(0, 8).join('、')} 等核心词重合，需进一步核对权利要求全文。`
      : '仅为领域相关候选，尚未发现足够的核心特征重合。'
  };
}

function dedupeCandidates(candidates: PriorArtCandidate[]) {
  const byTitle = new Map<string, PriorArtCandidate>();
  for (const candidate of candidates) {
    const key = candidate.title.replace(/[\s《》“”"'：:，,。.-]/g, '').toLowerCase();
    const existing = byTitle.get(key);
    if (!existing || candidate.score > existing.score) byTitle.set(key, candidate);
  }
  return [...byTitle.values()]
    .sort((left, right) => {
      const riskWeight = { high: 3, medium: 2, low: 1 };
      return riskWeight[right.risk] - riskWeight[left.risk] || right.score - left.score;
    })
    .slice(0, 12);
}

export async function searchPatentPriorArt(
  disclosure: InventionDisclosure,
  onStatus?: (detail: string) => void
): Promise<PriorArtReport> {
  const queries = buildPriorArtQueries(disclosure);
  const coreTerms = featureTerms(disclosure);
  const candidates: PriorArtCandidate[] = [];
  const ipcCodes = new Set<string>();
  for (const query of queries) {
    onStatus?.(`检索中国专利：${query.slice(0, 42)}`);
    const results = await searchRecords(query, {
      limit: 24,
      sourceTypes: ['patent', 'patent_chunk']
    });
    for (const result of results) {
      const searchable = `${result.title}\n${result.body}\n${JSON.stringify(result.fields)}`;
      for (const match of searchable.matchAll(/\b([A-HY]\d{2}[A-Z]\s*\d+\/\d+)\b/gi)) {
        ipcCodes.add(match[1].replace(/\s+/g, '').toUpperCase());
      }
    }
    candidates.push(
      ...results
        .filter((result) => result.sourceType === 'patent' || result.sourceType === 'patent_chunk')
        .map((result) => candidateFromResult(result, disclosure, coreTerms))
    );
  }
  const deduped = dedupeCandidates(candidates);
  return {
    queries,
    ipcCandidates: [...ipcCodes].slice(0, 12),
    candidates: deduped,
    closestPriorArtId: deduped[0]?.id,
    noveltyRisks: deduped
      .filter((candidate) => candidate.risk === 'high')
      .slice(0, 5)
      .map((candidate) => `${candidate.title}：${candidate.riskReason}`),
    searchLimitations: [
      '当前本地专利库以题录和摘要为主，候选排序不等于新颖性法律结论。',
      '正式申请前仍应由专利代理师核对最接近现有技术的权利要求全文、法律状态及公开日。',
      '检索范围不能排除尚未公开申请、非专利文献及其他语言现有技术。'
    ]
  };
}
