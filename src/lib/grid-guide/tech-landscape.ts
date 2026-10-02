import { searchRecords, type SearchResult } from '@/lib/search-index';
import type { TechLandscape, TechLandscapeEntry } from './types';

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
  '数据',
  '研究',
  '技术',
  '项目',
  '指南',
  '电网',
  '电力'
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

function sourceLabel(result: SearchResult) {
  const type = result.sourceType || '';
  if (type.startsWith('patent')) return '库内专利';
  if (type.startsWith('paper')) return '库内论文';
  if (type.includes('project') || type.includes('research')) return '库内科研项目';
  if (type.includes('mentor') || type.includes('people') || type.includes('person')) return '库内人才/团队';
  return '知识库记录';
}

function entryFromResult(result: SearchResult): TechLandscapeEntry {
  return {
    title: result.title.replace(/\s+/g, ' ').trim() || '未命名条目',
    gist: (result.snippet || result.body).replace(/\s+/g, ' ').trim().slice(0, 280),
    sourceLabel: sourceLabel(result)
  };
}

function dedupeEntries(entries: TechLandscapeEntry[]) {
  const byKey = new Map<string, TechLandscapeEntry>();
  for (const entry of entries) {
    const key = entry.title.replace(/[\s《》“”"'：:，,。.-]/g, '').toLowerCase();
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()].slice(0, 10);
}

export function buildCorpusSearchQueries(idea: string) {
  const core = terms(idea).slice(0, 16);
  const compact = idea.replace(/\s+/g, ' ').trim();
  const queries = [
    compact.slice(0, 48),
    core.slice(0, 6).join(' '),
    core.slice(3, 10).join(' '),
    [core[0], core[1], core[2], '电网'].filter(Boolean).join(' ')
  ]
    .map((query) => query.replace(/\s+/g, ' ').trim())
    .filter((query) => query.length >= 4);
  return [...new Set(queries)].slice(0, 4);
}

export async function searchCorpusExistingTech(
  idea: string,
  onStatus?: (detail: string) => void
): Promise<TechLandscapeEntry[]> {
  const queries = buildCorpusSearchQueries(idea);
  const entries: TechLandscapeEntry[] = [];
  for (const query of queries) {
    onStatus?.(`正在检索库内已有技术：${query.slice(0, 36)}`);
    const results = await searchRecords(query, {
      limit: 16,
      sourceTypes: ['paper', 'paper_chunk', 'patent', 'patent_chunk', 'project', 'research_project']
    });
    entries.push(...results.map(entryFromResult));
  }
  return dedupeEntries(entries);
}

export function formatCorpusHitsForPrompt(entries: TechLandscapeEntry[]) {
  if (!entries.length) {
    return '库内预检索未命中足够相关条目；请再用 grep/read 补充检索知识语料，并据此判断技术空白。';
  }
  return entries
    .map(
      (entry, index) =>
        `${index + 1}. [${entry.sourceLabel || '知识库'}] ${entry.title}\n   摘要：${entry.gist}`
    )
    .join('\n');
}

export function formatTechLandscapeChatSummary(landscape: TechLandscape): string {
  const lines: string[] = [
    '已完成库内已有技术检索、网络最新技术检索，以及「拟议新内容 / 已有技术 / 最新方向」对标分析，并据此完成指南与编制说明。',
    ''
  ];

  if (landscape.overview.trim()) {
    lines.push('【对标总览】', landscape.overview.trim(), '');
  }

  lines.push('【本指南提出的新内容】');
  if (landscape.differentiations.length) {
    landscape.differentiations.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.proposedInnovation}`);
      lines.push(`   · 相对库内已有：${item.differenceFromExisting}`);
      lines.push(`   · 相对最新方向：${item.differenceFromLatest}`);
    });
  } else {
    lines.push('（本轮未结构化列出差异点，请参见下文检索条目。）');
  }
  lines.push('');

  lines.push('【库内已有相关技术】');
  if (landscape.existingInCorpus.length) {
    landscape.existingInCorpus.forEach((item, index) => {
      const source = item.sourceLabel ? `（${item.sourceLabel}）` : '';
      lines.push(`${index + 1}. ${item.title}${source}`);
      lines.push(`   要点：${item.gist}`);
      if (item.gapOrDifference?.trim()) {
        lines.push(`   与本指南的区别：${item.gapOrDifference.trim()}`);
      }
    });
  } else {
    lines.push('未检出足够贴近的库内条目；本指南主要面向可识别的技术空白。');
  }
  lines.push('');

  lines.push('【网络最新技术方向】');
  if (landscape.latestOnline.length) {
    landscape.latestOnline.forEach((item, index) => {
      const source = item.sourceLabel ? `（${item.sourceLabel}）` : '';
      const url = item.url?.trim() ? ` ${item.url.trim()}` : '';
      lines.push(`${index + 1}. ${item.title}${source}${url}`);
      lines.push(`   要点：${item.gist}`);
      if (item.gapOrDifference?.trim()) {
        lines.push(`   与本指南的区别：${item.gapOrDifference.trim()}`);
      }
    });
  } else {
    lines.push('本轮联网检索未获得可核验的最新公开信息；差异判断主要依据库内证据与领域常识，建议后续再补检索。');
  }

  return lines.join('\n').trim();
}

export function emptyTechLandscape(): TechLandscape {
  return {
    overview: '',
    existingInCorpus: [],
    latestOnline: [],
    differentiations: []
  };
}
