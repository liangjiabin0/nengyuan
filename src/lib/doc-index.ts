/**
 * 默认推荐的文档级索引：只写 search_records（题名/摘要），最后一次性同步 FTS。
 * 不写海量 search_terms，不做 paper_chunk 分块索引（可按需另跑）。
 */
import { getDb, persistDbSummary } from './db';
import { ensureFtsIndex, syncFtsFromSearchRecords } from './fts-index';
import { hashText } from './normalize';
import { indexSourcesIncremental } from './search-index';
import { updateImportJobState } from './import-state';

function recordId(sourceType: string, sourceKey: string) {
  return `${sourceType}:${hashText(`${sourceKey}|`).slice(0, 20)}`;
}

export type DocIndexResult = {
  patents: number;
  papers: number;
  mentors: number;
  syncedFts: boolean;
  mode: 'docs';
};

async function bulkUpsertDocuments(
  kind: 'patent' | 'paper',
  keys?: string[],
  onProgress?: (done: number, total: number, message: string) => void
) {
  const db = getDb();
  ensureFtsIndex(db);
  const sourceType = kind;
  let rows: Array<{ paper_key: string; title: string; abstract: string; authors: string; keywords: string }>;

  if (keys?.length) {
    const uniq = [...new Set(keys.filter(Boolean))];
    const stmt = db.prepare(
      `SELECT paper_key, title, abstract, authors, keywords FROM paper_documents WHERE paper_key = ?`
    );
    rows = (
      await Promise.all(
        uniq.map((key) =>
          stmt.get<{ paper_key: string; title: string; abstract: string; authors: string; keywords: string }>(key)
        )
      )
    ).filter(Boolean) as typeof rows;
  } else {
    const like = kind === 'patent' ? "paper_key LIKE 'patent:%'" : "paper_key NOT LIKE 'patent:%'";
    rows = await db
      .prepare(
        `SELECT paper_key, title, abstract, authors, keywords
         FROM paper_documents p
         WHERE ${like}
           AND NOT EXISTS (
             SELECT 1 FROM search_records r
             WHERE r.source_key = p.paper_key AND r.source_type = ?
           )`
      )
      .all(sourceType);
  }

  if (!rows.length) return 0;

  const upsertRecord = db.prepare(`
    INSERT INTO search_records(record_id, source_type, source_key, title, body, fields_json, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(record_id) DO UPDATE SET
      title=excluded.title,
      body=excluded.body,
      fields_json=excluded.fields_json,
      updated_at=CURRENT_TIMESTAMP
  `);

  const batchSize = Math.max(100, Number(process.env.INDEX_BULK_BATCH || 1000) || 1000);
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    await db.transaction(async () => {
      for (const row of slice) {
        const id = recordId(sourceType, row.paper_key);
        const title = row.title || '';
        const body = String(row.abstract || '').slice(0, 3000);
        const fields = JSON.stringify({
          paper_key: row.paper_key,
          authors: row.authors || '',
          keywords: row.keywords || '',
          docKind: kind
        });
        await upsertRecord.run(id, sourceType, row.paper_key, title, body, fields);
      }
    });
    done += slice.length;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const rate = (done / Math.max(0.001, (Date.now() - t0) / 1000)).toFixed(0);
    const message = `批量索引${kind === 'patent' ? '专利' : '论文'}文档 ${done}/${rows.length} (${elapsed}s, ${rate}/s)`;
    onProgress?.(done, rows.length, message);
  }
  return rows.length;
}

/** 导入后默认索引：本轮变更文档 + 缺失文档补齐 + 导师 FTS_ONLY + 一次性 FTS */
export async function indexDocumentsFast(options: {
  paperKeys?: string[];
  mentorKeys?: string[];
  /** true 时也扫描并补齐库内缺失的文档级索引（默认 true） */
  fillMissing?: boolean;
} = {}): Promise<DocIndexResult> {
  const fillMissing = options.fillMissing !== false;
  const paperKeys = [...new Set((options.paperKeys || []).filter((k) => k && !k.startsWith('patent:')))];
  const patentKeys = [...new Set((options.paperKeys || []).filter((k) => k?.startsWith('patent:')))];
  const mentorKeys = [...new Set((options.mentorKeys || []).filter(Boolean))];

  const onProgress = async (done: number, total: number, message: string) => {
    updateImportJobState({
      phase: 'indexing',
      message,
      progress: { current: done, total }
    });
  };

  updateImportJobState({ phase: 'indexing', message: '文档级索引（专利/论文）…' });
  let patents = 0;
  let papers = 0;

  if (patentKeys.length) patents += await bulkUpsertDocuments('patent', patentKeys, onProgress);
  if (paperKeys.length) papers += await bulkUpsertDocuments('paper', paperKeys, onProgress);
  if (fillMissing) {
    patents += await bulkUpsertDocuments('patent', undefined, onProgress);
    papers += await bulkUpsertDocuments('paper', undefined, onProgress);
  }

  process.env.INDEX_FTS_ONLY = '1';
  process.env.SEARCH_INDEX_SYNC_FTS = '1';

  let mentors = 0;
  const mentorBatch = mentorKeys.length
    ? mentorKeys
    : fillMissing
      ? (
          await getDb()
            .prepare(
              `SELECT mentor_key AS k FROM mentor_profiles m
               WHERE NOT EXISTS (
                 SELECT 1 FROM search_records r
                 WHERE r.source_key = m.mentor_key AND r.source_type = 'mentor'
               )`
            )
            .all<{ k: string }>()
        ).map((row) => row.k)
      : [];

  for (let i = 0; i < mentorBatch.length; i += 300) {
    const slice = mentorBatch.slice(i, i + 300);
    await indexSourcesIncremental({ mentorKeys: slice });
    mentors += slice.length;
    updateImportJobState({
      phase: 'indexing',
      message: `索引导师 ${Math.min(i + slice.length, mentorBatch.length)}/${mentorBatch.length}`,
      progress: { current: Math.min(i + slice.length, mentorBatch.length), total: mentorBatch.length || 1 }
    });
  }

  updateImportJobState({ phase: 'indexing', message: '同步 FTS 全文索引…' });
  await syncFtsFromSearchRecords();
  await persistDbSummary({ includeSlowCounts: false });

  return { patents, papers, mentors, syncedFts: true, mode: 'docs' };
}
