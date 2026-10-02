import { all } from './db';
import type { SearchResult } from './search-index';

function parseFields(value?: string) {
  if (!value) return {} as Record<string, unknown>;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

export function extractInstitutionQuery(query: string, chatContext = '') {
  const haystack = `${query}\n${chatContext}`;
  for (const line of haystack.split('\n')) {
    const continued = line.match(/^延续机构:\s*(.+)$/);
    if (continued?.[1]) return continued[1].trim();
  }
  return haystack.match(/([\u4e00-\u9fa5]{2,12}大学)/)?.[1] || '';
}

export async function institutionRetrieve(query: string, chatContext = '', limit = 20): Promise<SearchResult[]> {
  const institution = extractInstitutionQuery(query, chatContext);
  if (!institution) return [];

  const rows = await all<{
    record_id: string;
    source_type: string;
    source_key: string;
    title: string;
    body: string;
    fields_json?: string;
  }>(
    `SELECT record_id, source_type, source_key, title, body, fields_json
     FROM search_records
     WHERE (title LIKE ? OR body LIKE ?)
       AND source_type IN ('paper', 'paper_chunk', 'mentor')
     ORDER BY CASE source_type WHEN 'paper' THEN 0 WHEN 'paper_chunk' THEN 1 ELSE 2 END
     LIMIT ?`,
    [`%${institution}%`, `%${institution}%`, Math.min(limit * 3, 48)]
  );

  return rows.map((row, index) => ({
    recordId: row.record_id,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    title: row.title,
    body: row.body,
    fields: parseFields(row.fields_json),
    score: 5550 - index,
    snippet: row.body.replace(/\s+/g, ' ').slice(0, 420),
    matchReason: `机构检索·${institution}`
  }));
}

export function mergeInstitutionFirstResults(instResults: SearchResult[], mergedResults: SearchResult[], limit: number) {
  if (!instResults.length) return mergedResults.slice(0, limit);
  const keys = new Set(instResults.map((r) => r.sourceKey || r.recordId));
  const rest = mergedResults.filter((r) => !keys.has(r.sourceKey) && !keys.has(r.recordId));
  return [...instResults, ...rest].slice(0, limit);
}
