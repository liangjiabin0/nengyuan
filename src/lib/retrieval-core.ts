import { all } from './db';
import { searchRecords, type SearchResult } from './search-index';
import { generateSearchTerms, tokenizeText } from './text';

export type RetrievedContext = {
  query: string;
  results: SearchResult[];
  entities: Array<{ entityKey: string; type: string; name: string; score: number }>;
  neighbors: Array<{ source: string; target: string; relation: string; weight: number }>;
  graphSeedIds: string[];
  contextText: string;
  evidence?: Array<{ id: string; recordId: string; sourceType: string; sourceKey: string; title: string; snippet: string; score: number; matchReason: string }>;
  confidence?: 'high' | 'medium' | 'low';
};

export function isPaperQuery(query: string) {
  return /论文|文献|算法|方法|模型|公式|引用|参考文献|交叉引用|在哪个文件|哪篇|PDF|CAJ/i.test(query);
}

function normalizeTitleKey(title: string) {
  return title
    .replace(/[_＿][^_＿]+$/, '')
    .replace(/[\s《》“”"'：:，,。；;（）()\-—_/\\]/g, '')
    .toLowerCase();
}

/** 短核用于子串包含；长核保留更多题名信息 */
function titleCore(title: string, maxLen = 80) {
  return normalizeTitleKey(title).slice(0, maxLen);
}

function titleBigrams(text: string) {
  const s = normalizeTitleKey(text);
  if (s.length < 2) return new Set<string>(s ? [s] : []);
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) grams.add(s.slice(i, i + 2));
  return grams;
}

export function titleOverlapRatio(query: string, title: string) {
  const q = normalizeTitleKey(query);
  const t = normalizeTitleKey(title);
  if (!q || !t) return 0;
  if (t.includes(q) || q.includes(t)) return 1;
  const qb = titleBigrams(q);
  const tb = titleBigrams(t);
  if (!qb.size || !tb.size) return 0;
  let inter = 0;
  for (const g of qb) if (tb.has(g)) inter += 1;
  return inter / Math.max(qb.size, tb.size);
}

/** 长串题名查询：避免被同义词扩展冲散 */
export function looksLikePaperTitleQuery(query: string) {
  const compact = query.replace(/\s+/g, '');
  if (compact.length < 16) return false;
  if (/[?？]|有哪些|哪些|统计|多少|导师|学校|请只|如果研究|请给出|请检索|请查找|请对照/.test(query)) return false;
  // 题名通常含技术词且标点较少
  const han = (compact.match(/[\u4e00-\u9fa5]/g) || []).length;
  return han >= 12 || /SiC|MOSFET|HVDC|MMC|VSG|LCC|DAB/i.test(compact);
}

export const PAPER_FAMILY_SOURCE_TYPES = ['paper', 'paper_chunk', 'patent', 'patent_chunk'] as const;

export function isPaperFamilySourceType(sourceType: string) {
  return (PAPER_FAMILY_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

export async function buildCitationEvidence(query: string) {
  if (!/引用|交叉引用|参考文献/.test(query)) return '';
  const papers = await all<{ paper_key: string; title: string; references_json?: string }>('SELECT paper_key, title, references_json FROM paper_documents');
  const mentioned = papers.filter((paper) => {
    const core = titleCore(paper.title);
    return core.length >= 8 && query.replace(/\s/g, '').includes(core);
  }).slice(0, 6);
  if (mentioned.length < 2) return '';

  const paperKeys = mentioned.map((paper) => paper.paper_key);
  const marks = paperKeys.map(() => '?').join(',');
  const citeEdges = await all<{ source_key: string; target_key: string }>(
    `SELECT source_key, target_key FROM edges WHERE relation = 'cites_paper' AND source_key IN (${marks}) AND target_key IN (${marks})`,
    [...paperKeys, ...paperKeys]
  );
  const citeSet = new Set(citeEdges.map((edge) => `${edge.source_key}|${edge.target_key}`));

  const lines: string[] = [];
  for (const source of mentioned) {
    const references = source.references_json ? JSON.parse(source.references_json) as string[] : [];
    for (const target of mentioned) {
      if (source.paper_key === target.paper_key) continue;
      const targetCore = titleCore(target.title);
      const matchedReference = references.find((reference) => reference.replace(/\s/g, '').includes(targetCore));
      if (matchedReference || citeSet.has(`${source.paper_key}|${target.paper_key}`)) {
        lines.push(`${source.title} --cites_paper--> ${target.title}${matchedReference ? `；参考文献片段：${matchedReference.slice(0, 260)}` : ''}`);
      } else {
        lines.push(`${source.title} --no_citation_evidence_found--> ${target.title}`);
      }
    }
  }
  return lines.length ? `\n\n交叉引用核验证据:\n${lines.join('\n')}` : '';
}

function parseFields(value?: string) {
  if (!value) return {} as Record<string, unknown>;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function makeDbSearchResult(row: { record_id: string; source_type: string; source_key: string; title: string; body: string; fields_json?: string }, score: number): SearchResult {
  return {
    recordId: row.record_id,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    title: row.title,
    body: row.body,
    fields: parseFields(row.fields_json),
    score,
    snippet: row.body.replace(/\s+/g, ' ').slice(0, 420)
  };
}

function isContextualPaperReference(query: string) {
  return /这篇|那篇|这份|那份|这个\s*(PDF|文件|文献|论文)?|那个\s*(PDF|文件|文献|论文)?|上面|前面|刚才|上一[篇个份]/i.test(query);
}

type PaperIdentity = { paper_key: string; title: string; file_path?: string; pdf_path?: string };

let paperCatalogCache: { loadedAt: number; papers: PaperIdentity[] } | null = null;
const PAPER_CATALOG_TTL_MS = 60_000;

async function getPaperCatalog() {
  const now = Date.now();
  if (paperCatalogCache && now - paperCatalogCache.loadedAt < PAPER_CATALOG_TTL_MS) {
    return paperCatalogCache.papers;
  }
  const papers = await all<PaperIdentity>('SELECT paper_key, title, file_path, pdf_path FROM paper_documents');
  paperCatalogCache = { loadedAt: now, papers };
  return papers;
}

function mentionedPapersInText(text: string, papers: PaperIdentity[]) {
  const normalizedText = normalizeTitleKey(text);
  const substringHits = papers
    .map((paper) => {
      const core = titleCore(paper.title, 80);
      const shortCore = titleCore(paper.title, 40);
      let titleIndex = -1;
      if (core.length >= 8) titleIndex = normalizedText.lastIndexOf(core);
      if (titleIndex < 0 && shortCore.length >= 8) titleIndex = normalizedText.lastIndexOf(shortCore);
      // 查询包含题名核心，或题名核心包含查询（用户只复述部分长题名）
      if (titleIndex < 0 && core.length >= 12 && (core.includes(normalizedText) || normalizedText.includes(core.slice(0, Math.min(24, core.length))))) {
        titleIndex = 0;
      }
      const fileNameCore = titleCore(String(paper.file_path || paper.pdf_path || '').split(/[\\/]/).pop() || '');
      const fileIndex = fileNameCore.length >= 8 ? normalizedText.lastIndexOf(fileNameCore) : -1;
      const index = Math.max(titleIndex, fileIndex);
      const overlap = titleOverlapRatio(text, paper.title);
      return { paper, index, overlap };
    });

  const exact = substringHits
    .filter((match) => match.index >= 0)
    .sort((a, b) => b.index - a.index || b.overlap - a.overlap)
    .map((match) => match.paper);
  if (exact.length) return exact;

  // 长题名：用 bigram 重叠兜底锁定
  if (normalizedText.length >= 16) {
    return substringHits
      .filter((match) => match.overlap >= 0.45)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 5)
      .map((match) => match.paper);
  }
  return [];
}

function uniqueTerms(terms: string[]) {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const value = term.trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function extractPaperChunkTerms(query: string, paperTitle: string) {
  const terms = extractQueryTerms(query).filter((term) => !paperTitle.includes(term));
  if (/公式|方程|数学|损失|函数|指标|评价|矩阵|概率|图卷积|因果|模型|网络|算法/i.test(query)) {
    terms.unshift('公式', '式中', '损失函数', '评价指标', '混淆矩阵', '概率', 'Sigmoid', 'GCN', 'PCMCI', '因果', '图卷积');
  }
  return uniqueTerms(terms).slice(0, 16);
}

export async function findMentionedPaperRecords(query: string, limit: number, chatContext = ''): Promise<SearchResult[]> {
  const papers = await getPaperCatalog();
  const queryMentioned = mentionedPapersInText(query, papers).slice(0, 3);
  const contextMentioned = !queryMentioned.length && chatContext && isContextualPaperReference(query)
    ? mentionedPapersInText(chatContext, papers).slice(0, 1)
    : [];
  let mentioned = queryMentioned.length ? queryMentioned : contextMentioned;

  // 长题名：目录子串失败时用 SQL 高重叠兜底（保留汉字连续片段，避免把 LCC-HVDC 归一成 lcchvdc 导致 LIKE 失败）
  if (!mentioned.length && looksLikePaperTitleQuery(query)) {
    const compact = query.replace(/\s+/g, '');
    const hanChunks = compact.match(/[\u4e00-\u9fa5]{6,24}/g) || [];
    const needles = [...new Set([
      compact.slice(0, 24),
      ...hanChunks.slice(0, 4),
      compact.slice(0, 16)
    ].filter((n) => n.length >= 6))];
    const candidates: PaperIdentity[] = [];
    const seen = new Set<string>();
    for (const needle of needles) {
      const rows = await all<PaperIdentity>(
        `SELECT paper_key, title, file_path, pdf_path FROM paper_documents WHERE title LIKE ? LIMIT 24`,
        [`%${needle}%`]
      );
      for (const row of rows) {
        if (seen.has(row.paper_key)) continue;
        seen.add(row.paper_key);
        candidates.push(row);
      }
    }
    mentioned = candidates
      .map((paper) => ({ paper, overlap: titleOverlapRatio(query, paper.title) }))
      .filter((item) => item.overlap >= 0.35)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 3)
      .map((item) => item.paper);
  }

  if (!mentioned.length) return [];

  const records: SearchResult[] = [];
  for (const paper of mentioned) {
    const isPatent = paper.paper_key.startsWith('patent:');
    const docTypes = isPatent ? ['patent', 'paper'] : ['paper', 'patent'];
    const chunkTypes = isPatent ? ['patent_chunk', 'paper_chunk'] : ['paper_chunk', 'patent_chunk'];
    const lockScore = 6000 + Math.floor(titleOverlapRatio(query, paper.title) * 200);
    const paperRows = await all<{ record_id: string; source_type: string; source_key: string; title: string; body: string; fields_json?: string }>(
      `SELECT record_id, source_type, source_key, title, body, fields_json FROM search_records
       WHERE source_key = ? AND source_type IN (?, ?) LIMIT 1`,
      [paper.paper_key, docTypes[0], docTypes[1]]
    );
    if (paperRows.length) {
      records.push(...paperRows.map((row) => makeDbSearchResult(row, lockScore)));
    } else {
      // 文档已入库但尚未写入 search_records：仍返回锁定结果，避免长题名丢失
      records.push({
        recordId: `${isPatent ? 'patent' : 'paper'}-lock:${paper.paper_key}`,
        sourceType: isPatent ? 'patent' : 'paper',
        sourceKey: paper.paper_key,
        title: paper.title,
        body: paper.title,
        fields: {
          paper_key: paper.paper_key,
          title: paper.title,
          file_path: paper.file_path,
          pdf_path: paper.pdf_path,
          docKind: isPatent ? 'patent' : 'paper'
        },
        score: lockScore,
        snippet: paper.title,
        matchReason: '题名高重叠锁定'
      });
    }

    const terms = extractPaperChunkTerms(query, paper.title);
    const chunkRows = await all<{ record_id: string; source_type: string; source_key: string; title: string; body: string; fields_json?: string; text: string }>(
      `SELECT sr.record_id, sr.source_type, sr.source_key, sr.title, sr.body, sr.fields_json, pc.text
       FROM paper_chunks pc
       JOIN search_records sr ON sr.source_key = pc.chunk_key AND sr.source_type IN (?, ?)
       WHERE pc.paper_key = ?
       ORDER BY CASE WHEN ${terms.length ? terms.map(() => 'pc.text LIKE ?').join(' OR ') : '1 = 1'} THEN 0 ELSE 1 END, pc.chunk_index
       LIMIT ?`,
      [chunkTypes[0], chunkTypes[1], paper.paper_key, ...terms.map((term) => `%${term}%`), limit]
    );
    if (chunkRows.length) {
      records.push(...chunkRows.map((row, index) => {
        const result = makeDbSearchResult(row, lockScore - 50 - index);
        return {
          ...result,
          fields: { ...result.fields, text: row.text },
          snippet: row.text.replace(/\s+/g, ' ').slice(0, 420)
        };
      }));
    } else {
      const rawChunks = await all<{ chunk_key: string; section?: string; text: string }>(
        `SELECT chunk_key, section, text FROM paper_chunks
         WHERE paper_key = ? AND COALESCE(chunk_role,'child') = 'child' AND COALESCE(section,'') <> '参考文献'
         ORDER BY chunk_index LIMIT ?`,
        [paper.paper_key, Math.min(4, limit)]
      );
      records.push(...rawChunks.map((chunk, index) => ({
        recordId: `chunk-lock:${chunk.chunk_key}`,
        sourceType: isPatent ? 'patent_chunk' : 'paper_chunk',
        sourceKey: chunk.chunk_key,
        title: `${paper.title}${chunk.section ? ` · ${chunk.section}` : ''}`,
        body: chunk.text,
        fields: {
          paper_key: paper.paper_key,
          chunk_key: chunk.chunk_key,
          section: chunk.section,
          text: chunk.text,
          docKind: isPatent ? 'patent' : 'paper'
        },
        score: lockScore - 50 - index,
        snippet: chunk.text.replace(/\s+/g, ' ').slice(0, 420),
        matchReason: '题名高重叠锁定'
      })));
    }
  }
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.recordId)) return false;
    seen.add(record.recordId);
    return true;
  }).slice(0, limit);
}

export function expandedPaperQuery(query: string) {
  // 长题名精确查询时不做同义词扩展，避免近义主题抢榜
  if (looksLikePaperTitleQuery(query)) return query;

  const expansions = new Set<string>([query]);
  const normalized = query.replace(/\s/g, '');
  const synonymGroups = [
    ['光热电', '光热发电', '太阳能光热发电', 'CSP', 'concentrated solar power'],
    ['虚拟电厂', 'VPP', 'virtual power plant'],
    ['构网', '构网型', 'grid-forming', 'GFM'],
    ['现货', '电力现货市场'],
    ['调度', '优化调度', '运行优化'],
    ['引用', '参考文献', '交叉引用']
  ];
  for (const group of synonymGroups) {
    if (group.some((term) => normalized.toLowerCase().includes(term.toLowerCase()))) {
      group.forEach((term) => expansions.add(term));
    }
  }
  for (const match of normalized.matchAll(/([\p{Script=Han}]{1,3})(老师|教授|博士|作者)/gu)) {
    expansions.add(match[1]);
  }
  return [...expansions].join('\n');
}

export async function findFuzzyPaperRecords(query: string, limit: number): Promise<SearchResult[]> {
  if (!isPaperQuery(query)) return [];
  const expanded = expandedPaperQuery(query);
  const candidates = await searchRecords(expanded, {
    limit: Math.max(limit * 2, 20),
    sourceTypes: [...PAPER_FAMILY_SOURCE_TYPES]
  });
  const seenPaperKeys = new Set<string>();
  const selected: SearchResult[] = [];
  for (const candidate of candidates) {
    const paperKey = candidate.sourceType === 'paper_chunk' || candidate.sourceType === 'patent_chunk'
      ? String(candidate.fields.paper_key || '')
      : candidate.sourceKey;
    if (!paperKey || seenPaperKeys.has(paperKey)) continue;
    seenPaperKeys.add(paperKey);
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function extractQueryTerms(question: string) {
  const terms = generateSearchTerms(question, 1, 20).map((term) => term.term);
  return [...new Set([...tokenizeText(question), ...terms])].slice(0, 24);
}
