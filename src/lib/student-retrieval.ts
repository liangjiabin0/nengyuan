import { all } from './db';
import type { SearchResult } from './search-index';
import { extractCoreDirectionTerms, extractResearchDirections } from './mentor-retrieval';

const STUDENT_IDENTITY = /硕士研究生|硕士生|博士研究生|博士生/;
const STUDENT_QUERY = /硕士研究生|硕士生|博士研究生|博士生|^那(?:硕士(?:研究生)?|博士(?:研究生)?|研究生|学生)/;
const STUDENT_BIO_SCOPE = `(c.chunk_role = 'child' OR (c.chunk_role = 'parent' AND (c.text LIKE '%作者简介%' OR c.text LIKE '%收稿日期%')))`;

export function isStudentListQuery(query: string) {
  if (STUDENT_QUERY.test(query.trim())) return true;
  if (/学生.{0,12}发表|有没有学生.+论文|学生发表/.test(query)) return true;
  return STUDENT_IDENTITY.test(query) && /哪些|还有|呢|谁|有没有/.test(query);
}

function parseFields(value?: string) {
  if (!value) return {} as Record<string, unknown>;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function bioSection(text: string) {
  const markers = ['作者简介', '收稿日期', '基金项目', '通信作者'];
  let start = text.length;
  for (const marker of markers) {
    const index = text.lastIndexOf(marker);
    if (index >= 0) start = Math.min(start, index);
  }
  return start < text.length ? text.slice(start) : text.slice(-1200);
}

function rankStudentChunk(
  row: { text: string; title: string },
  directions: string[],
  coreTerms: string[]
) {
  const bio = bioSection(row.text);
  let bonus = 0;
  if (/作者简介/.test(row.text)) bonus += 140;
  if (/硕士研究生/.test(bio)) bonus += 100;
  if (/研究方向[为是]/.test(bio)) bonus += 90;
  if (/硕士研究生/.test(bio) && /研究方向[为是]/.test(bio)) {
    if (coreTerms.length >= 2 && coreTerms.every((term) => bio.includes(term))) bonus += 280;
    for (const direction of directions) {
      if (bio.includes(direction)) bonus += 160;
    }
  }
  for (const direction of directions) {
    if (bio.includes(direction)) bonus += 120;
    else if (row.text.includes(direction)) bonus += 60;
  }
  for (const term of coreTerms) {
    if (bio.includes(term)) bonus += 35;
    else if (row.text.includes(term)) bonus += 15;
  }
  const authorMatch = (row.title || '').match(/_([^_·]+)/);
  if (authorMatch && bio.includes(authorMatch[1])) bonus += 80;
  return bonus;
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
    title: row.title || row.text.slice(0, 80).replace(/\s+/g, ' '),
    body: row.body || row.text || '',
    fields: {
      ...fields,
      paper_key: row.paper_key,
      chunk_key: row.chunk_key,
      section: row.section,
      text: row.text,
      student_match: true,
      bio_section: /作者简介|收稿日期/.test(row.text)
    },
    score,
    snippet: row.text.replace(/\s+/g, ' ').slice(0, 420),
    matchReason
  };
}

function extractStudentDirections(query: string, chatContext = '') {
  const directions = new Set(extractResearchDirections(query, chatContext));
  for (const line of chatContext.split('\n')) {
    const shared = line.match(/^共享研究方向:\s*(.+)$/);
    if (shared?.[1]) directions.add(shared[1].trim().replace(/的$/, ''));
    const topic = line.match(/^当前检索主题:\s*(.+)$/);
    if (topic?.[1]) directions.add(topic[1].trim().replace(/的$/, ''));
  }
  for (const match of chatContext.matchAll(/用户:\s*研究方向[为是：:]\s*([^\n]+)/g)) {
    const phrase = match[1]
      .replace(/还有哪些(?:老师|教师|导师|教授).*$/, '')
      .replace(/的$/, '')
      .trim();
    if (phrase.length >= 4) directions.add(phrase);
  }
  return [...directions].filter((direction) => direction.length >= 4).slice(0, 6);
}

export async function studentRetrieve(query: string, chatContext = '', limit = 24): Promise<SearchResult[]> {
  if (!isStudentListQuery(query)) return [];

  const directions = extractStudentDirections(query, chatContext);
  const coreTerms = extractCoreDirectionTerms(directions);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const directionClause = coreTerms.length >= 2
    ? coreTerms.map(() => 'c.text LIKE ?').join(' AND ')
    : '';
  const directionParams = coreTerms.map((term) => `%${term}%`);

  const queries: Array<{ sql: string; params: unknown[]; baseScore: number; reason: string }> = [];

  if (directionClause) {
    queries.push({
      sql: `SELECT sr.record_id, c.chunk_key, c.paper_key, c.section, c.text, sr.title, sr.body, sr.fields_json
            FROM paper_chunks c
            LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
            WHERE ${STUDENT_BIO_SCOPE}
              AND c.text LIKE '%硕士研究生%'
              AND ${directionClause}
            ORDER BY c.updated_at DESC LIMIT ?`,
      params: [...directionParams, Math.min(limit * 3, 48)],
      baseScore: 5920,
      reason: '作者简介·硕士研究生+方向'
    });
  }

  queries.push({
    sql: `SELECT sr.record_id, c.chunk_key, c.paper_key, c.section, c.text, sr.title, sr.body, sr.fields_json
          FROM paper_chunks c
          LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
          WHERE c.chunk_role = 'child' AND c.text LIKE '%硕士研究生%'
          ${directionClause ? `AND ${directionClause}` : ''}
          ORDER BY c.updated_at DESC LIMIT ?`,
    params: directionClause
      ? [...directionParams, Math.min(limit * 4, 80)]
      : [Math.min(limit * 4, 80)],
    baseScore: 5600,
    reason: '硕士研究生+方向共现'
  });

  for (const direction of directions) {
    queries.push({
      sql: `SELECT sr.record_id, c.chunk_key, c.paper_key, c.section, c.text, sr.title, sr.body, sr.fields_json
            FROM paper_chunks c
            LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
            WHERE ${STUDENT_BIO_SCOPE}
              AND c.text LIKE '%硕士研究生%'
              AND c.text LIKE ?
            ORDER BY c.updated_at DESC LIMIT ?`,
      params: [`%${direction}%`, Math.min(limit * 3, 60)],
      baseScore: 5800,
      reason: `硕士研究生+方向(${direction})`
    });
    queries.push({
      sql: `SELECT sr.record_id, c.chunk_key, c.paper_key, c.section, c.text, sr.title, sr.body, sr.fields_json
            FROM paper_chunks c
            LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
            WHERE c.chunk_role = 'child' AND c.text LIKE '%硕士研究生%' AND c.text LIKE ?
            ORDER BY c.updated_at DESC LIMIT ?`,
      params: [`%${direction}%`, Math.min(limit * 3, 60)],
      baseScore: 5700,
      reason: `硕士研究生+方向(${direction})`
    });
    if (/人工智能/.test(direction) && /电力系统/.test(direction)) {
      queries.push({
        sql: `SELECT sr.record_id, c.chunk_key, c.paper_key, c.section, c.text, sr.title, sr.body, sr.fields_json
              FROM paper_chunks c
              LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
              WHERE c.chunk_role = 'child' AND c.text LIKE '%硕士研究生%' AND (c.text LIKE '%人工智能与电力系统%' OR c.text LIKE '%人工智能技术在电力系统%')
              ORDER BY c.updated_at DESC LIMIT ?`,
        params: [Math.min(limit * 3, 60)],
        baseScore: 5750,
        reason: `硕士研究生+AI电力短语`
      });
    }
  }

  if (!directions.length && coreTerms.length < 2) {
    queries.push({
      sql: `SELECT sr.record_id, c.chunk_key, c.paper_key, c.section, c.text, sr.title, sr.body, sr.fields_json
            FROM paper_chunks c
            LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
            WHERE c.chunk_role = 'child' AND (c.text LIKE '%硕士研究生%' OR c.text LIKE '%硕士生%')
            ORDER BY c.updated_at DESC LIMIT ?`,
      params: [Math.min(limit * 3, 60)],
      baseScore: 5200,
      reason: '硕士研究生档案'
    });
  }

  for (const entry of queries) {
    const rows = await all<{
      record_id?: string;
      chunk_key: string;
      paper_key: string;
      title: string;
      body: string;
      fields_json?: string;
      section?: string;
      text: string;
    }>(entry.sql, entry.params);

    for (const [index, row] of rows.entries()) {
      if (seen.has(row.chunk_key)) continue;
      if (!STUDENT_IDENTITY.test(row.text)) continue;
      seen.add(row.chunk_key);
      const rankBonus = rankStudentChunk(row, directions, coreTerms);
      results.push(makeChunkResult(row, entry.baseScore - index + rankBonus, `学生检索·${entry.reason}`));
    }
  }

  return results
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function resultKey(result: SearchResult) {
  return result.sourceKey || result.recordId;
}

export function mergeStudentFirstResults(studentResults: SearchResult[], mergedResults: SearchResult[], limit: number) {
  if (!studentResults.length) return mergedResults.slice(0, limit);
  const sortedStudents = [...studentResults].sort((left, right) => right.score - left.score);
  const studentKeys = new Set(sortedStudents.map(resultKey));
  const rest = mergedResults.filter((result) => !studentKeys.has(resultKey(result)));
  return [...sortedStudents, ...rest].slice(0, limit);
}
