import type { Database } from './db';
import { all, get, getDb, invalidateDbCaches, withTransaction } from './db';
import { syncFtsFromSearchRecords, upsertFtsRecord } from './fts-index';
import { migrateLegacyPaperChunksInDb } from './parent-chunk';
import { getCached } from './query-cache';
import { entityKey, hashText } from './normalize';
import { generateSearchTerms, normalizeKeyText, normalizeText, serializeRecordBody, similarityScore, tokenizeText } from './text';

type ProjectRow = Record<string, unknown> & { project_key: string; project_name?: string; project_name_en?: string; institution?: string; principal_investigator?: string; year?: string; keywords?: string; summary?: string };
type OutputRow = Record<string, unknown> & { output_key: string; project_key: string; title?: string; publication?: string; authors?: string };
type EntityRow = { entity_key: string; type: string; name: string; meta?: string };
type RawRow = { id: number; source_file_id: number; row_index: number; project_key?: string; payload: string };
type PaperDocumentRow = Record<string, unknown> & {
  paper_key: string;
  title: string;
  authors?: string;
  file_path: string;
  pdf_path: string;
  original_path?: string;
  page_count?: number;
  abstract?: string;
  keywords?: string;
  references_json?: string;
  citations_json?: string;
  algorithms_json?: string;
};
type MentorProfileRow = {
  mentor_key: string;
  name: string;
  school?: string;
  college?: string;
  major?: string;
  email?: string;
  phone?: string;
  title?: string;
  file_path: string;
  content: string;
};
type PaperChunkRow = {
  chunk_key: string;
  paper_key: string;
  chunk_index: number;
  page_start?: number | null;
  page_end?: number | null;
  section?: string;
  text: string;
  token_estimate?: number;
  parent_key?: string | null;
  chunk_role?: string;
};

export type SearchResult = {
  recordId: string;
  sourceType: string;
  sourceKey: string;
  title: string;
  body: string;
  fields: Record<string, unknown>;
  score: number;
  snippet: string;
  matchReason?: string;
};

async function runInDb(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) await db.prepare(sql).run(...params);
  else await db.prepare(sql).run();
}

function safeJson(value?: string) {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeJsonArray(value?: string) {
  if (!value) return [] as string[];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [] as string[];
  }
}

function recordId(sourceType: string, sourceKey: string, suffix = '') {
  return `${sourceType}:${hashText(`${sourceKey}|${suffix}`).slice(0, 20)}`;
}

async function upsertSearchRecordInDb(db: Database, input: {
  recordId: string;
  sourceType: string;
  sourceKey: string;
  title?: string;
  body: string;
  fields: Record<string, unknown>;
  sourceFileId?: number | null;
  rowIndex?: number | null;
}) {
  await runInDb(
    db,
    `INSERT INTO search_records(record_id, source_type, source_key, title, body, fields_json, source_file_id, row_index, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(record_id) DO UPDATE SET
       source_type=excluded.source_type,
       source_key=excluded.source_key,
       title=excluded.title,
       body=excluded.body,
       fields_json=excluded.fields_json,
       source_file_id=excluded.source_file_id,
       row_index=excluded.row_index,
       updated_at=CURRENT_TIMESTAMP`,
    [input.recordId, input.sourceType, input.sourceKey, input.title || '', input.body, JSON.stringify(input.fields), input.sourceFileId ?? null, input.rowIndex ?? null]
  );
}

async function upsertAliasInDb(db: Database, alias: string | undefined, entity: Pick<EntityRow, 'entity_key' | 'type'>, confidence = 1) {
  const normalized = normalizeKeyText(alias);
  if (!normalized || !alias) return;
  await runInDb(
    db,
    `INSERT INTO entity_aliases(normalized_alias, alias, entity_key, type, confidence, source_count, updated_at)
     VALUES(?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(normalized_alias, type) DO UPDATE SET
       entity_key=excluded.entity_key,
       alias=excluded.alias,
       confidence=GREATEST(entity_aliases.confidence, excluded.confidence),
       source_count=entity_aliases.source_count + 1,
       updated_at=CURRENT_TIMESTAMP`,
    [normalized, alias, entity.entity_key, entity.type, confidence]
  );
}

async function addMention(db: Database, recordIdValue: string, entityKeyValue: string, relation = 'mentions', weight = 1) {
  await runInDb(
    db,
    `INSERT INTO entity_mentions(record_id, entity_key, relation, weight)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(record_id, entity_key, relation) DO UPDATE SET weight=entity_mentions.weight + excluded.weight`,
    [recordIdValue, entityKeyValue, relation, weight]
  );
}

async function rowsInDb<T>(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) return db.prepare(sql).all<T>(...params);
  return db.prepare(sql).all<T>();
}

export async function indexProjectInDb(db: Database, project: ProjectRow) {
  const fields = { ...project };
  const body = serializeRecordBody(fields);
  const title = String(project.project_name || project.project_name_en || project.project_key);
  const id = recordId('project', project.project_key);
  await upsertSearchRecordInDb(db, { recordId: id, sourceType: 'project', sourceKey: project.project_key, title, body, fields });
}

export async function indexOutputInDb(db: Database, output: OutputRow) {
  const fields = { ...output };
  const body = serializeRecordBody(fields);
  const title = String(output.title || output.output_key);
  const id = recordId('output', output.output_key);
  await upsertSearchRecordInDb(db, { recordId: id, sourceType: 'output', sourceKey: output.output_key, title, body, fields });
}

export async function indexEntityInDb(db: Database, entity: EntityRow) {
  const meta = safeJson(entity.meta);
  const fields = { entity_key: entity.entity_key, type: entity.type, name: entity.name, ...meta };
  const body = serializeRecordBody(fields);
  const id = recordId('entity', entity.entity_key);
  await upsertSearchRecordInDb(db, { recordId: id, sourceType: 'entity', sourceKey: entity.entity_key, title: entity.name, body, fields });
  await upsertAliasInDb(db, entity.name, entity);
}

export async function indexRawRecordInDb(db: Database, row: RawRow) {
  const payload = safeJson(row.payload);
  const title = String(payload.projectName || payload['项目名'] || payload.outputTitle || payload['成果标题'] || `原始记录 ${row.id}`);
  const fields = { id: row.id, source_file_id: row.source_file_id, row_index: row.row_index, project_key: row.project_key, ...payload };
  const body = serializeRecordBody(fields);
  const id = recordId('raw', String(row.id));
  await upsertSearchRecordInDb(db, { recordId: id, sourceType: 'raw', sourceKey: String(row.id), title, body, fields, sourceFileId: row.source_file_id, rowIndex: row.row_index });
}

export async function indexMentorProfileInDb(db: Database, mentor: MentorProfileRow) {
  const fields = {
    mentor_key: mentor.mentor_key,
    name: mentor.name,
    school: mentor.school,
    college: mentor.college,
    major: mentor.major,
    email: mentor.email,
    phone: mentor.phone,
    title: mentor.title,
    file_path: mentor.file_path
  };
  const body = serializeRecordBody({ ...fields, content: mentor.content });
  const title = [mentor.name, mentor.school, mentor.college].filter(Boolean).join(' · ');
  await upsertSearchRecordInDb(db, {
    recordId: recordId('mentor', mentor.mentor_key),
    sourceType: 'mentor',
    sourceKey: mentor.mentor_key,
    title,
    body,
    fields
  });
}

export function isPatentDocument(paper: { paper_key?: string; keywords?: string; file_path?: string; original_path?: string; pdf_path?: string }) {
  const key = String(paper.paper_key || '');
  if (key.startsWith('patent:')) return true;
  const keywords = String(paper.keywords || '');
  if (/发明公开|实用新型|发明授权|外观设计/.test(keywords)) return true;
  const pathText = `${paper.file_path || ''} ${paper.original_path || ''} ${paper.pdf_path || ''}`;
  if (/专利信息|[/\\]专利[/\\]/.test(pathText)) return true;
  return false;
}

function paperDocSourceType(paper: PaperDocumentRow) {
  return isPatentDocument(paper) ? 'patent' : 'paper';
}

function paperChunkSourceType(paper: { paper_key: string; keywords?: string; file_path?: string; original_path?: string; pdf_path?: string }, chunk?: { section?: string }) {
  if (isPatentDocument(paper) || chunk?.section === '专利全文') return 'patent_chunk';
  return 'paper_chunk';
}

let patentRelabelDone = false;

/** 将已入库但仍标为 paper 的专利记录纠正为 patent / patent_chunk（进程内一次） */
export async function ensurePatentSourceTypesRelabeled(db?: Database) {
  if (patentRelabelDone) return;
  patentRelabelDone = true;
  const database = db || getDb();
  try {
    await database.prepare(
      `UPDATE search_records SET source_type = 'patent'
       WHERE source_type = 'paper' AND source_key LIKE 'patent:%'`
    ).run();
    await database.prepare(
      `UPDATE search_records SET source_type = 'patent_chunk'
       WHERE source_type = 'paper_chunk' AND source_key LIKE 'patent:%'`
    ).run();
  } catch {
    // ignore if table missing during early boot
  }
}

export async function indexPaperDocumentInDb(db: Database, paper: PaperDocumentRow) {
  const references = Array.isArray(paper.references_json) ? paper.references_json : safeJsonArray(paper.references_json);
  const citations = safeJsonArray(paper.citations_json);
  const algorithms = safeJsonArray(paper.algorithms_json);
  const patent = isPatentDocument(paper);
  const sourceType = paperDocSourceType(paper);
  const fields = {
    paper_key: paper.paper_key,
    title: paper.title,
    authors: paper.authors,
    file_path: paper.file_path,
    pdf_path: paper.pdf_path,
    original_path: paper.original_path,
    page_count: paper.page_count,
    abstract: paper.abstract,
    keywords: paper.keywords,
    references,
    citations,
    algorithms,
    docKind: patent ? 'patent' : 'paper'
  };
  const body = serializeRecordBody(fields);
  const id = recordId(sourceType, paper.paper_key);
  await upsertSearchRecordInDb(db, { recordId: id, sourceType, sourceKey: paper.paper_key, title: paper.title, body, fields });
}

export async function indexPaperChunkInDb(db: Database, paper: { paper_key: string; title: string; authors?: string; file_path?: string; pdf_path?: string; keywords?: string; original_path?: string }, chunk: PaperChunkRow) {
  if (chunk.chunk_role === 'parent' || chunk.chunk_role === 'reference') return;
  if (chunk.section === '参考文献') return;
  const patent = isPatentDocument(paper) || chunk.section === '专利全文';
  const sourceType = paperChunkSourceType(paper, chunk);
  const fields = {
    paper_key: chunk.paper_key,
    chunk_key: chunk.chunk_key,
    chunk_index: chunk.chunk_index,
    page_start: chunk.page_start,
    page_end: chunk.page_end,
    section: chunk.section,
    parent_key: chunk.parent_key,
    chunk_role: chunk.chunk_role || 'child',
    paper_title: paper.title,
    authors: paper.authors,
    pdf_path: paper.pdf_path,
    text: chunk.text,
    docKind: patent ? 'patent' : 'paper'
  };
  const title = `${paper.title}${chunk.section ? ` · ${chunk.section}` : ''}`;
  const body = serializeRecordBody({ ...fields, text: chunk.text });
  await upsertSearchRecordInDb(db, { recordId: recordId(sourceType, chunk.chunk_key), sourceType, sourceKey: chunk.chunk_key, title, body, fields });
}

/** 仅索引本轮变更的论文/导师；同步 FTS upsert，不做全表 DELETE */
export async function indexSourcesIncremental(options: {
  paperKeys?: string[];
  mentorKeys?: string[];
} = {}) {
  const paperKeys = [...new Set((options.paperKeys || []).filter(Boolean))];
  const mentorKeys = [...new Set((options.mentorKeys || []).filter(Boolean))];
  if (!paperKeys.length && !mentorKeys.length) {
    return { papers: 0, mentors: 0, chunks: 0, searchRecords: 0 };
  }

  const prevFts = process.env.SEARCH_INDEX_SYNC_FTS;
  process.env.SEARCH_INDEX_SYNC_FTS = '1';
  try {
    const stats = await withTransaction(async (db) => {
      let chunkCount = 0;
      for (const key of mentorKeys) {
        const mentor = await db
          .prepare(
            'SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content FROM mentor_profiles WHERE mentor_key = ?'
          )
          .get<MentorProfileRow>(key);
        if (mentor) await indexMentorProfileInDb(db, mentor);
      }

      for (const key of paperKeys) {
        const paper = await db.prepare('SELECT * FROM paper_documents WHERE paper_key = ?').get<PaperDocumentRow>(key);
        if (!paper) continue;
        await indexPaperDocumentInDb(db, paper);
        const skipChunks = process.env.INDEX_DOCS_ONLY === '1' || (process.env.INDEX_SKIP_PATENT_CHUNKS === '1' && String(paper.paper_key || '').startsWith('patent:'));
        if (skipChunks) continue;
        const chunks = await db
          .prepare(
            `SELECT chunk_key, paper_key, chunk_index, page_start, page_end, section, text, token_estimate, parent_key, chunk_role
             FROM paper_chunks WHERE paper_key = ? ORDER BY chunk_index`
          )
          .all<PaperChunkRow>(key);
        for (const chunk of chunks) {
          if (chunk.chunk_role === 'parent' || chunk.chunk_role === 'reference') continue;
          if (chunk.section === '参考文献') continue;
          await indexPaperChunkInDb(db, paper, chunk);
          chunkCount += 1;
        }
      }

      return {
        papers: paperKeys.length,
        mentors: mentorKeys.length,
        chunks: chunkCount,
        searchRecords: Number((await db.prepare('SELECT COUNT(*) FROM search_records').pluck().get()) || 0)
      };
    }, true);

    invalidateDbCaches();
    return stats;
  } finally {
    if (prevFts === undefined) delete process.env.SEARCH_INDEX_SYNC_FTS;
    else process.env.SEARCH_INDEX_SYNC_FTS = prevFts;
  }
}

export async function rebuildSearchIndex() {
  return withTransaction(async (db) => {
    const parentChildMigration = await migrateLegacyPaperChunksInDb(db);
    patentRelabelDone = false;

    await runInDb(db, 'DELETE FROM search_records');
    await runInDb(db, 'DELETE FROM entity_aliases');
    await runInDb(db, 'DELETE FROM entity_mentions');

    const projects = await rowsInDb<ProjectRow>(db, 'SELECT * FROM projects');
    const outputs = await rowsInDb<OutputRow>(db, 'SELECT * FROM outputs');
    const entities = await rowsInDb<EntityRow>(db, 'SELECT * FROM entities');
    const rawRows = await rowsInDb<RawRow>(db, 'SELECT id, source_file_id, row_index, project_key, payload FROM raw_records');
    const mentors = await rowsInDb<MentorProfileRow>(db, 'SELECT mentor_key, name, school, college, major, email, phone, title, file_path, content FROM mentor_profiles');
    const papers = await rowsInDb<PaperDocumentRow>(db, 'SELECT * FROM paper_documents');
    const paperChunks = await rowsInDb<PaperChunkRow & { title: string; authors?: string; file_path?: string; pdf_path?: string }>(
      db,
      `SELECT c.*, p.title, p.authors, p.file_path, p.pdf_path
       FROM paper_chunks c
       JOIN paper_documents p ON p.paper_key = c.paper_key
       ORDER BY c.paper_key, c.chunk_index`
    );
    const edges = await rowsInDb<{ source_key: string; target_key: string; relation: string; weight: number }>(db, 'SELECT source_key, target_key, relation, weight FROM edges');

    for (const project of projects) await indexProjectInDb(db, project);
    for (const mentor of mentors) await indexMentorProfileInDb(db, mentor);
    for (const output of outputs) await indexOutputInDb(db, output);
    for (const entity of entities) await indexEntityInDb(db, entity);
    for (const row of rawRows) await indexRawRecordInDb(db, row);
    for (const paper of papers) await indexPaperDocumentInDb(db, paper);
    for (const chunk of paperChunks) {
      if (chunk.chunk_role === 'parent' || chunk.chunk_role === 'reference') continue;
      if (chunk.section === '参考文献') continue;
      await indexPaperChunkInDb(db, chunk, chunk);
    }

    const searchBySource = new Map<string, string>();
    const records = await rowsInDb<{ record_id: string; source_type: string; source_key: string }>(db, 'SELECT record_id, source_type, source_key FROM search_records');
    for (const record of records) searchBySource.set(record.source_key, record.record_id);
    for (const edge of edges) {
      const sourceRecord = searchBySource.get(edge.source_key);
      if (sourceRecord) await addMention(db, sourceRecord, edge.target_key, edge.relation, edge.weight || 1);
      const targetRecord = searchBySource.get(edge.target_key);
      if (targetRecord) await addMention(db, targetRecord, edge.source_key, edge.relation, edge.weight || 1);
    }

    return {
      ...await getIndexStatsInDb(db),
      parentChildMigration
    };
  }, true).then(async (result) => {
    await syncFtsFromSearchRecords();
    invalidateDbCaches();
    const { persistDbSummary } = await import('./db');
    await persistDbSummary({
      indexStats: {
        searchRecords: result.searchRecords,
        searchTerms: result.searchTerms,
        aliases: result.aliases,
        mentions: result.mentions,
        mergeCandidates: result.mergeCandidates
      },
      includeSlowCounts: true
    });
    return result;
  });
}

function makeSnippet(body: string, query: string) {
  const normalizedQuery = normalizeText(query);
  const bodyText = body.replace(/\s+/g, ' ');
  const candidates = tokenizeText(normalizedQuery).filter((item) => item.length >= 2);
  let index = -1;
  for (const candidate of candidates) {
    index = normalizeText(bodyText).indexOf(candidate);
    if (index >= 0) break;
  }
  if (index < 0) return bodyText.slice(0, 220);
  return bodyText.slice(Math.max(0, index - 80), index + 180);
}

const genericRecallTerms = new Set([
  '这个', '那个', '情况', '信息', '是谁', '里面', '存在', '获取',
  '关系', '关联', '关联了', '的人', '这个人', '哪些成果', '哪些项目',
  '在哪', '在哪个', '出现'
]);

function isInsideDecimalSpan(index: number, length: number, spans: Array<[number, number]>) {
  const end = index + length;
  return spans.some(([start, stop]) => index >= start && end <= stop);
}

function extractRecallPhrases(query: string) {
  const raw = String(query || '').normalize('NFKC');
  const phrases = new Set<string>();
  const decimalSpans: Array<[number, number]> = [];

  for (const match of raw.matchAll(/\d+\.\d+/g)) {
    phrases.add(match[0]);
    decimalSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
  }

  for (const match of raw.matchAll(/\d+(?:\.\d+)?\s*(?:MW|mw|kV|kW|kWh|MWh|GW|Hz|Ω|°C|mm|cm|km|%|％|V|A)/gi)) {
    phrases.add(match[0].replace(/\s+/g, ' ').trim());
  }

  for (const match of raw.matchAll(/[\p{Script=Han}]{2,12}|[A-Za-z][A-Za-z0-9._-]{1,40}|\d{2,}/gu)) {
    const value = match[0].trim();
    const index = match.index ?? 0;
    if (!value) continue;
    if (/^\d+$/.test(value) && isInsideDecimalSpan(index, value.length, decimalSpans)) continue;
    phrases.add(value);
    if (/^[\p{Script=Han}]+$/u.test(value) && value.length > 3) {
      for (let size = 2; size <= Math.min(4, value.length); size += 1) {
        for (let offset = 0; offset <= value.length - size; offset += 1) phrases.add(value.slice(offset, offset + size));
      }
    }
  }

  return [...phrases].filter((phrase) => {
    if (genericRecallTerms.has(phrase)) return false;
    if (/^\d{1,2}$/.test(phrase)) return false;
    if ([...genericRecallTerms].some((term) => phrase === term || (phrase.length <= 4 && term.includes(phrase)))) return false;
    return true;
  });
}

async function addExactRecallScores(query: string, scores: Map<string, number>, limit: number) {
  const phrases = extractRecallPhrases(query).slice(0, 20);
  const normalizedPhrases = [...new Set(phrases.map((phrase) => normalizeKeyText(phrase)).filter(Boolean))];
  if (!normalizedPhrases.length) return;

  const aliasMarks = normalizedPhrases.map(() => '?').join(',');
  const aliasEntities = await all<{ entity_key: string }>(
    `SELECT entity_key FROM entity_aliases WHERE normalized_alias IN (${aliasMarks}) LIMIT ?`,
    [...normalizedPhrases, limit * 4]
  );
  const entityKeys = [...new Set(aliasEntities.map((row) => row.entity_key))];

  if (entityKeys.length) {
    const entityMarks = entityKeys.map(() => '?').join(',');
    const [entityRecords, mentionRows, edgeRows] = await Promise.all([
      all<{ record_id: string }>(`SELECT record_id FROM search_records WHERE source_key IN (${entityMarks})`, entityKeys),
      all<{ record_id: string }>(`SELECT DISTINCT record_id FROM entity_mentions WHERE entity_key IN (${entityMarks}) LIMIT ?`, [...entityKeys, limit * 8]),
      all<{ source_key: string; target_key: string }>(`SELECT source_key, target_key FROM edges WHERE source_key IN (${entityMarks}) OR target_key IN (${entityMarks}) LIMIT ?`, [...entityKeys, ...entityKeys, limit * 8])
    ]);
    entityRecords.forEach((row) => scores.set(row.record_id, Math.max(scores.get(row.record_id) || 0, 1000)));
    mentionRows.forEach((row) => scores.set(row.record_id, Math.max(scores.get(row.record_id) || 0, 900)));

    const edgeKeys = [...new Set(edgeRows.flatMap((edge) => [edge.source_key, edge.target_key]))];
    if (edgeKeys.length) {
      const edgeMarks = edgeKeys.map(() => '?').join(',');
      const edgeRecords = await all<{ record_id: string }>(`SELECT record_id FROM search_records WHERE source_key IN (${edgeMarks})`, edgeKeys);
      edgeRecords.forEach((row) => scores.set(row.record_id, Math.max(scores.get(row.record_id) || 0, 840)));
    }
  }

  const topPhrases = phrases.slice(0, 8);
  for (const phrase of topPhrases) {
    const exactRows = await all<{ record_id: string; source_type: string }>(
      `SELECT record_id, source_type FROM search_records WHERE title LIKE ? OR body LIKE ? LIMIT ?`,
      [`%${phrase}%`, `%${phrase}%`, limit * 2]
    );
    exactRows.forEach((row) => {
      const isDecimal = /^\d+\.\d+$/.test(phrase);
      const boost = isDecimal
        ? row.source_type === 'paper_chunk'
          ? 5100
          : row.source_type === 'paper'
            ? 1200
            : 900
        : row.source_type === 'paper' || row.source_type === 'patent'
          ? 980
          : row.source_type === 'paper_chunk' || row.source_type === 'patent_chunk'
            ? 960
            : row.source_type === 'entity'
              ? 800
              : row.source_type === 'raw'
                ? 720
                : 780;
      scores.set(row.record_id, Math.max(scores.get(row.record_id) || 0, boost));
    });
  }

  if (normalizedPhrases.length) {
    const mentionRows = await all<{ record_id: string }>(
      `SELECT DISTINCT m.record_id
       FROM entity_aliases ea
       JOIN entity_mentions m ON m.entity_key = ea.entity_key
       WHERE ea.normalized_alias IN (${aliasMarks})
       LIMIT ?`,
      [...normalizedPhrases, limit * 6]
    );
    mentionRows.forEach((row) => scores.set(row.record_id, Math.max(scores.get(row.record_id) || 0, 860)));
  }
}

export async function searchRecords(query: string, options: { limit?: number; sourceTypes?: string[] } = {}): Promise<SearchResult[]> {
  await ensurePatentSourceTypesRelabeled();
  const limit = Math.min(80, Math.max(1, options.limit || 24));
  const genericTerms = new Set(genericRecallTerms);
  const terms = generateSearchTerms(query, 1, 40).map((item) => item.term).filter((term) => !genericTerms.has(term) && term.length >= 2);
  const scores = new Map<string, number>();

  await addExactRecallScores(query, scores, limit);
  await addTitlePhraseBoosts(query, scores, limit);
  const literalPhrase = query.trim().replace(/[“”"'《》]/g, '');
  if (literalPhrase.length >= 2 && literalPhrase.length <= 32 && !/[?？；;，,]/.test(literalPhrase)) {
    const literalTypes = new Set(options.sourceTypes || []);
    if (literalTypes.has('paper') || literalTypes.has('paper_chunk')) {
      literalTypes.add('patent');
      literalTypes.add('patent_chunk');
    }
    const typeClause = literalTypes.size
      ? ` AND source_type IN (${[...literalTypes].map(() => '?').join(',')})`
      : '';
    const literalRows = await all<{ record_id: string }>(
      `SELECT record_id FROM search_records WHERE (title LIKE ? OR body LIKE ?)${typeClause} LIMIT ?`,
      [`%${literalPhrase}%`, `%${literalPhrase}%`, ...literalTypes, limit * 4]
    );
    literalRows.forEach((row) => scores.set(row.record_id, Math.max(scores.get(row.record_id) || 0, 1100)));
    if (literalTypes.size && literalRows.length) {
      const literalIds = [...new Set(literalRows.map((row) => row.record_id))].slice(0, limit * 2);
      const literalMarks = literalIds.map(() => '?').join(',');
      const literalRecords = await all<{
        record_id: string;
        source_type: string;
        source_key: string;
        title: string;
        body: string;
        fields_json?: string;
      }>(
        `SELECT record_id, source_type, source_key, title, body, fields_json
         FROM search_records WHERE record_id IN (${literalMarks})`,
        literalIds
      );
      return literalRecords
        .map((row) => ({
          recordId: row.record_id,
          sourceType: row.source_type,
          sourceKey: row.source_key,
          title: row.title,
          body: row.body,
          fields: safeJson(row.fields_json),
          score: row.title.includes(literalPhrase) ? 6200 : 1100,
          snippet: makeSnippet(row.body, literalPhrase),
          matchReason: row.title.includes(literalPhrase) ? '题名精确短语' : '正文精确短语'
        } satisfies SearchResult))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    }
  }

  const likeTokens = tokenizeText(query).filter((item) => item.length >= 2 && !genericTerms.has(item)).slice(0, 8);
  for (const token of likeTokens) {
    const rows = await all<{ record_id: string }>('SELECT record_id FROM search_records WHERE body LIKE ? OR title LIKE ? LIMIT ?', [`%${token}%`, `%${token}%`, limit * 2]);
    rows.forEach((row) => scores.set(row.record_id, (scores.get(row.record_id) || 0) + 2));
  }

  const lockedDocs = await lockPapersFromDocumentsTable(query, Math.min(6, limit));
  if (!scores.size) {
    return filterBySourceTypes(lockedDocs, options.sourceTypes).slice(0, limit);
  }
  let rankedEntries = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (options.sourceTypes?.length) {
    const requestedTypes = new Set(options.sourceTypes);
    if (requestedTypes.has('paper') || requestedTypes.has('paper_chunk')) {
      requestedTypes.add('patent');
      requestedTypes.add('patent_chunk');
    }
    const allowedIds = new Set<string>();
    const rankedIds = rankedEntries.map(([id]) => id);
    for (let offset = 0; offset < rankedIds.length; offset += 400) {
      const batch = rankedIds.slice(offset, offset + 400);
      const idMarks = batch.map(() => '?').join(',');
      const typeMarks = [...requestedTypes].map(() => '?').join(',');
      const matches = await all<{ record_id: string }>(
        `SELECT record_id FROM search_records WHERE record_id IN (${idMarks}) AND source_type IN (${typeMarks})`,
        [...batch, ...requestedTypes]
      );
      matches.forEach((row) => allowedIds.add(row.record_id));
    }
    rankedEntries = rankedEntries.filter(([id]) => allowedIds.has(id));
  }
  const ids = rankedEntries.slice(0, limit * 2).map(([id]) => id);
  if (!ids.length) {
    return filterBySourceTypes(lockedDocs, options.sourceTypes).slice(0, limit);
  }
  const marks = ids.map(() => '?').join(',');
  const rows = await all<{ record_id: string; source_type: string; source_key: string; title: string; body: string; fields_json?: string }>(
    `SELECT record_id, source_type, source_key, title, body, fields_json FROM search_records WHERE record_id IN (${marks})`,
    ids
  );
  const typeFilter = new Set(options.sourceTypes || []);
  // paper 族过滤时兼容 patent
  if (typeFilter.has('paper') || typeFilter.has('paper_chunk')) {
    typeFilter.add('patent');
    typeFilter.add('patent_chunk');
  }
  const ranked = rows
    .filter((row) => !typeFilter.size || typeFilter.has(row.source_type))
    .map((row) => {
      const base = scores.get(row.record_id) || similarityScore(query, `${row.title}\n${row.body}`);
      const titleBoost = titlePhraseBoost(query, row.title);
      return {
        recordId: row.record_id,
        sourceType: row.source_type,
        sourceKey: row.source_key,
        title: row.title,
        body: row.body,
        fields: safeJson(row.fields_json),
        score: Math.max(base, titleBoost),
        snippet: makeSnippet(row.body, query),
        matchReason: titleBoost >= 5500 ? '题名高重叠锁定' : undefined
      } as SearchResult;
    });

  const lockedFiltered = filterBySourceTypes(lockedDocs, options.sourceTypes);
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const item of [...lockedFiltered, ...ranked.sort((a, b) => b.score - a.score)]) {
    const key = item.recordId || `${item.sourceType}:${item.sourceKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    if (merged.length >= limit) break;
  }
  return merged;
}

function filterBySourceTypes(results: SearchResult[], sourceTypes?: string[]) {
  if (!sourceTypes?.length) return results;
  const typeFilter = new Set(sourceTypes);
  if (typeFilter.has('paper') || typeFilter.has('paper_chunk')) {
    typeFilter.add('patent');
    typeFilter.add('patent_chunk');
  }
  return results.filter((row) => typeFilter.has(row.sourceType));
}

/** 不依赖 search_records：从 paper_documents 做长题名高重叠锁定 */
async function lockPapersFromDocumentsTable(query: string, limit: number): Promise<SearchResult[]> {
  const compact = query.replace(/\s+/g, '');
  if (compact.length < 16) return [];
  if (/[?？]|有哪些|哪些|统计|多少|导师|请只|如果研究|请给出|请检索/.test(query)) return [];
  const hanChunks = compact.match(/[\u4e00-\u9fa5]{6,24}/g) || [];
  const needles = [...new Set([compact.slice(0, 24), ...hanChunks.slice(0, 4), compact.slice(0, 16)].filter((n) => n.length >= 6))];
  if (!needles.length) return [];

  const seen = new Set<string>();
  const candidates: Array<{ paper_key: string; title: string; file_path?: string; pdf_path?: string }> = [];
  for (const needle of needles) {
    const rows = await all<{ paper_key: string; title: string; file_path?: string; pdf_path?: string }>(
      `SELECT paper_key, title, file_path, pdf_path FROM paper_documents WHERE title LIKE ? LIMIT 24`,
      [`%${needle}%`]
    );
    for (const row of rows) {
      if (seen.has(row.paper_key)) continue;
      seen.add(row.paper_key);
      candidates.push(row);
    }
  }

  return candidates
    .map((paper) => {
      const boost = titlePhraseBoost(query, paper.title);
      const isPatent = paper.paper_key.startsWith('patent:');
      return {
        paper,
        boost,
        isPatent
      };
    })
    .filter((item) => item.boost >= 2200)
    .sort((a, b) => b.boost - a.boost)
    .slice(0, limit)
    .map((item) => ({
      recordId: `${item.isPatent ? 'patent' : 'paper'}-lock:${item.paper.paper_key}`,
      sourceType: item.isPatent ? 'patent' : 'paper',
      sourceKey: item.paper.paper_key,
      title: item.paper.title,
      body: item.paper.title,
      fields: {
        paper_key: item.paper.paper_key,
        title: item.paper.title,
        file_path: item.paper.file_path,
        pdf_path: item.paper.pdf_path,
        docKind: item.isPatent ? 'patent' : 'paper'
      },
      score: item.boost,
      snippet: item.paper.title,
      matchReason: '题名高重叠锁定'
    }));
}

function titlePhraseBoost(query: string, title: string) {
  const q = normalizeKeyText(query).replace(/\s+/g, '');
  const t = normalizeKeyText(title).replace(/\s+/g, '');
  if (!q || !t || q.length < 8) return 0;
  if (t.includes(q) || q.includes(t)) return 6200;
  // bigram Jaccard
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const qb = grams(q);
  const tb = grams(t);
  if (!qb.size || !tb.size) return 0;
  let inter = 0;
  for (const g of qb) if (tb.has(g)) inter += 1;
  const ratio = inter / Math.max(qb.size, tb.size);
  if (ratio >= 0.55 && q.length >= 12) return 5600 + Math.floor(ratio * 400);
  if (ratio >= 0.4 && q.length >= 16) return 2200 + Math.floor(ratio * 1000);
  return 0;
}

async function addTitlePhraseBoosts(query: string, scores: Map<string, number>, limit: number) {
  const compact = query.replace(/\s+/g, '');
  if (compact.length < 12) return;
  const hanChunks = compact.match(/[\u4e00-\u9fa5]{6,24}/g) || [];
  // 保留原始汉字片段做 LIKE；不要把 LCC-HVDC 归一掉
  const needles = [...new Set([
    compact.slice(0, 24),
    ...hanChunks.slice(0, 4),
    compact.slice(0, 16)
  ].filter((n) => n.length >= 6))];
  for (const needle of needles) {
    const rows = await all<{ record_id: string; title: string; source_type: string }>(
      `SELECT record_id, title, source_type FROM search_records
       WHERE source_type IN ('paper','patent','paper_chunk','patent_chunk') AND title LIKE ?
       LIMIT ?`,
      [`%${needle}%`, limit * 3]
    );
    for (const row of rows) {
      const boost = titlePhraseBoost(query, row.title);
      if (boost > 0) scores.set(row.record_id, Math.max(scores.get(row.record_id) || 0, boost));
    }
  }
}

export async function getIndexStatsUncached(_includeSlowCounts = false) {
  const stats = await get<Record<string, number>>(
    `SELECT
      (SELECT COUNT(*) FROM search_records) AS "searchRecords",
      (SELECT COUNT(*) FROM entity_aliases) AS aliases,
      (SELECT COUNT(*) FROM entity_mentions) AS mentions,
      (SELECT COUNT(*) FROM merge_candidates WHERE status = 'pending') AS "mergeCandidates"`
  );
  const { readDbSummary } = await import('./db-summary');
  return {
    searchRecords: Number(stats?.searchRecords || 0),
    searchTerms: readDbSummary()?.indexStats?.searchTerms ?? 0,
    aliases: Number(stats?.aliases || 0),
    mentions: Number(stats?.mentions || 0),
    mergeCandidates: Number(stats?.mergeCandidates || 0)
  };
}

export async function getIndexStats() {
  const { readDbSummary } = await import('./db-summary');
  const summary = readDbSummary();
  if (summary?.indexStats) return summary.indexStats;
  return getCached('index:summary', 60_000, () => getIndexStatsUncached(false));
}

async function getIndexStatsInDb(db: Database) {
  const one = async (sql: string) => Number((await db.prepare(sql).pluck().get()) || 0);
  return {
    searchRecords: await one('SELECT COUNT(*) FROM search_records'),
    searchTerms: 0,
    aliases: await one('SELECT COUNT(*) FROM entity_aliases'),
    mentions: await one('SELECT COUNT(*) FROM entity_mentions'),
    mergeCandidates: await one("SELECT COUNT(*) FROM merge_candidates WHERE status = 'pending'")
  };
}

export function canonicalEntityKey(type: string, name?: string) {
  const normalized = normalizeKeyText(name);
  return normalized ? entityKey(type, normalized) : null;
}
