import { all } from './db';
import type { SearchResult } from './search-index';

export type LiteralAnchor = {
  text: string;
  kind: 'decimal' | 'unit' | 'quoted' | 'formula';
  strict: boolean;
};

export type LiteralCoverage = {
  anchors: LiteralAnchor[];
  strictAnchors: LiteralAnchor[];
  satisfied: boolean;
  missing: string[];
  isSourceQuery: boolean;
};

function uniqueAnchors(items: LiteralAnchor[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractLiteralAnchors(query: string): LiteralAnchor[] {
  const raw = String(query || '').normalize('NFKC');
  const anchors: LiteralAnchor[] = [];
  const decimalSpans: Array<[number, number]> = [];

  for (const match of raw.matchAll(/\d+\.\d+/g)) {
    anchors.push({ text: match[0], kind: 'decimal', strict: true });
    decimalSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }

  for (const match of raw.matchAll(/\d+(?:\.\d+)?\s*(?:MW|mw|kV|kW|kWh|MWh|GW|Hz|Ω|°C|mm|cm|km|%|％|V|A|Pa|bar|rpm)/gi)) {
    anchors.push({ text: match[0].replace(/\s+/g, ' ').trim(), kind: 'unit', strict: true });
  }

  for (const match of raw.matchAll(/[「『"']([^」』"']{4,80})[」』"']/g)) {
    anchors.push({ text: match[1].trim(), kind: 'quoted', strict: true });
  }

  for (const match of raw.matchAll(/式\s*[（(]?\s*\d+\s*[）)]?/g)) {
    anchors.push({ text: match[0].replace(/\s+/g, ''), kind: 'formula', strict: true });
  }

  for (const match of raw.matchAll(/\b[A-Z]{2,}(?:-[A-Z0-9]+)?\b/g)) {
    if (match[0].length >= 3 && match[0].length <= 12) {
      anchors.push({ text: match[0], kind: 'quoted', strict: false });
    }
  }

  const deduped = uniqueAnchors(anchors).filter((anchor) => {
    if (anchor.kind === 'decimal' || anchor.kind === 'unit' || anchor.kind === 'formula') return true;
    if (anchor.kind === 'quoted') return anchor.text.length >= 4;
    return anchor.text.length >= 3;
  });

  const strict = deduped.filter((anchor) => anchor.strict);
  const units = strict.filter((anchor) => anchor.kind === 'unit');
  if (units.length) {
    const unitTexts = new Set(units.map((anchor) => anchor.text));
    return deduped.filter((anchor) => {
      if (anchor.kind !== 'decimal') return true;
      return ![...unitTexts].some((unit) => unit.includes(anchor.text));
    });
  }

  return deduped;
}

export function isSourceLookupQuery(query: string) {
  return /哪篇|哪个论文|哪篇论文|出自|来源于|出自哪|来自哪|在哪个文件|在哪篇|原文|片段|是哪篇|是哪一个|什么论文/.test(query);
}

export function evaluateLiteralCoverage(query: string, results: SearchResult[]): LiteralCoverage {
  const anchors = extractLiteralAnchors(query);
  const strictAnchors = anchors.filter((anchor) => anchor.strict);
  const isSourceQuery = isSourceLookupQuery(query) || strictAnchors.length > 0;

  if (!strictAnchors.length) {
    return { anchors, strictAnchors, satisfied: true, missing: [], isSourceQuery };
  }

  const haystacks = results.map((result) => `${result.title}\n${result.body}\n${JSON.stringify(result.fields)}`);
  const hasCooccurrence = haystacks.some((text) => strictAnchors.every((anchor) => text.includes(anchor.text)));
  const missing = hasCooccurrence
    ? []
    : strictAnchors
        .filter((anchor) => !haystacks.some((text) => text.includes(anchor.text)))
        .map((anchor) => anchor.text);

  return {
    anchors,
    strictAnchors,
    satisfied: hasCooccurrence,
    missing,
    isSourceQuery
  };
}

function parseFields(value?: string) {
  if (!value) return {} as Record<string, unknown>;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function makeChunkResult(row: {
  record_id?: string;
  chunk_key: string;
  paper_key: string;
  title: string;
  body: string;
  fields_json?: string;
  section?: string;
  text: string;
}, score: number, matchReason: string): SearchResult {
  const fields = parseFields(row.fields_json);
  return {
    recordId: row.record_id || `paper_chunk:${row.chunk_key}`,
    sourceType: 'paper_chunk',
    sourceKey: row.chunk_key,
    title: row.title,
    body: row.body || row.text,
    fields: {
      ...fields,
      paper_key: row.paper_key,
      chunk_key: row.chunk_key,
      section: row.section,
      text: row.text,
      literal_match: true
    },
    score,
    snippet: row.text.replace(/\s+/g, ' ').slice(0, 420),
    matchReason
  };
}

export async function literalRetrieve(query: string, limit = 20): Promise<SearchResult[]> {
  const anchors = extractLiteralAnchors(query);
  const strictAnchors = anchors.filter((anchor) => anchor.strict);
  if (!strictAnchors.length) return [];

  const cooccurrence = strictAnchors.length >= 2;
  const whereParts = strictAnchors.map(() => 'c.text LIKE ?');
  const params: unknown[] = [...strictAnchors.map((anchor) => `%${anchor.text}%`), Math.min(limit * 3, 60)];

  const chunkRows = await all<{
    record_id: string;
    chunk_key: string;
    paper_key: string;
    title: string;
    body: string;
    fields_json?: string;
    section?: string;
    text: string;
  }>(
    `SELECT sr.record_id, c.chunk_key, c.paper_key, c.section, c.text,
            sr.title, sr.body, sr.fields_json
     FROM paper_chunks c
     JOIN paper_documents p ON p.paper_key = c.paper_key
     LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
     WHERE c.chunk_role = 'child' AND ${whereParts.join(' AND ')}
     ORDER BY c.updated_at DESC
     LIMIT ?`,
    params
  );

  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const [index, row] of chunkRows.entries()) {
    if (seen.has(row.chunk_key)) continue;
    seen.add(row.chunk_key);
    const score = cooccurrence ? 5200 - index : 4800 - index;
    results.push(
      makeChunkResult(
        row,
        score,
        cooccurrence ? `字面量共现(${strictAnchors.map((a) => a.text).join(' + ')})` : `字面量精确命中(${strictAnchors[0].text})`
      )
    );
  }

  if (results.length) return results.slice(0, limit);

  const primary = strictAnchors.find((anchor) => anchor.kind === 'decimal' || anchor.kind === 'unit') || strictAnchors[0];
  const singleRows = await all<typeof chunkRows[number]>(
    `SELECT sr.record_id, c.chunk_key, c.paper_key, c.section, c.text,
            sr.title, sr.body, sr.fields_json
     FROM paper_chunks c
     JOIN paper_documents p ON p.paper_key = c.paper_key
     LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
     WHERE c.chunk_role = 'child' AND c.text LIKE ?
     ORDER BY length(c.text) ASC
     LIMIT ?`,
    [`%${primary.text}%`, Math.min(limit * 4, 80)]
  );

  for (const [index, row] of singleRows.entries()) {
    if (seen.has(row.chunk_key)) continue;
    seen.add(row.chunk_key);
    results.push(makeChunkResult(row, 4600 - index, `字面量精确命中(${primary.text})`));
  }

  if (results.length) return results.slice(0, limit);

  const recordRows = await all<{
    record_id: string;
    source_type: string;
    source_key: string;
    title: string;
    body: string;
    fields_json?: string;
  }>(
    `SELECT record_id, source_type, source_key, title, body, fields_json
     FROM search_records
     WHERE body LIKE ?
     ORDER BY CASE source_type WHEN 'paper_chunk' THEN 0 WHEN 'paper' THEN 1 ELSE 2 END
     LIMIT ?`,
    [`%${primary.text}%`, limit]
  );

  return recordRows.map((row, index) => ({
    recordId: row.record_id,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    title: row.title,
    body: row.body,
    fields: { ...parseFields(row.fields_json), literal_match: true },
    score: 4200 - index,
    snippet: row.body.replace(/\s+/g, ' ').slice(0, 420),
    matchReason: `字面量命中(${primary.text})`
  }));
}

export function mergeLiteralFirstResults(literalResults: SearchResult[], mergedResults: SearchResult[], limit: number) {
  if (!literalResults.length) return mergedResults.slice(0, limit);
  const literalIds = new Set(literalResults.map((result) => result.recordId));
  const rest = mergedResults.filter((result) => !literalIds.has(result.recordId));
  return [...literalResults, ...rest].slice(0, limit);
}

export function filterEvidenceForLiteralQuery(coverage: LiteralCoverage, results: SearchResult[]) {
  if (!coverage.strictAnchors.length) return results;
  if (coverage.satisfied) {
    const strict = results.filter((result) =>
      coverage.strictAnchors.every((anchor) =>
        `${result.title}\n${result.body}\n${JSON.stringify(result.fields)}`.includes(anchor.text)
      )
    );
    return strict.length ? strict : results;
  }
  return results;
}
