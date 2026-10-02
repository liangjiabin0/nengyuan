/**
 * 快速补齐检索索引：只处理尚未进入 search_records 的条目。
 */
import { getDb, persistDbSummary } from '../src/lib/db';
import { indexSourcesIncremental } from '../src/lib/search-index';
import { resetImportJobState, updateImportJobState } from '../src/lib/import-state';

function allKeys(sql: string) {
  return (getDb().prepare(sql).all() as Array<{ k: string }>).map((row) => row.k);
}

async function runBatches(
  label: string,
  keys: string[],
  batchSize: number,
  kind: 'paper' | 'mentor',
  baseDone: number,
  totalAll: number,
  t0: number
) {
  let done = 0;
  for (let i = 0; i < keys.length; i += batchSize) {
    const slice = keys.slice(i, i + batchSize);
    await indexSourcesIncremental(kind === 'mentor' ? { mentorKeys: slice } : { paperKeys: slice });
    done += slice.length;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const rate = done / Math.max(0.001, (Date.now() - t0) / 1000);
    const msg = `索引${label} ${done}/${keys.length} (${elapsed}s, ${rate.toFixed(1)}/s)`;
    console.log(msg);
    updateImportJobState({
      phase: 'indexing',
      message: msg,
      progress: { current: baseDone + done, total: totalAll }
    });
  }
  return done;
}

async function main() {
  const patentBatch = Math.max(50, Number(process.env.INDEX_PATENT_BATCH || 300) || 300);
  const paperBatch = Math.max(1, Number(process.env.INDEX_PAPER_BATCH || 8) || 8);
  const mentorBatch = Math.max(50, Number(process.env.INDEX_MENTOR_BATCH || 300) || 300);
  const forceAll = process.env.INDEX_FORCE_ALL === '1';
  process.env.INDEX_FAST_TERMS = process.env.INDEX_FAST_TERMS ?? '1';
  process.env.INDEX_FTS_ONLY = process.env.INDEX_FTS_ONLY ?? '1';
  process.env.INDEX_SKIP_PATENT_CHUNKS = process.env.INDEX_SKIP_PATENT_CHUNKS ?? '1';
  process.env.SEARCH_INDEX_SYNC_FTS = '1';

  resetImportJobState();
  updateImportJobState({
    status: 'running',
    phase: 'indexing',
    message: '增量补齐检索索引（仅缺口）…',
    startedAt: new Date().toISOString()
  });

  // 缺文档级索引，或存在未索引的 child chunk
  const patentKeys = forceAll
    ? allKeys("SELECT paper_key AS k FROM paper_documents WHERE paper_key LIKE 'patent:%' ORDER BY paper_key")
    : allKeys(`
      SELECT p.paper_key AS k
      FROM paper_documents p
      WHERE p.paper_key LIKE 'patent:%'
        AND (
          NOT EXISTS (
            SELECT 1 FROM search_records r
            WHERE r.source_key = p.paper_key AND r.source_type = 'patent'
          )
          OR EXISTS (
            SELECT 1 FROM paper_chunks c
            WHERE c.paper_key = p.paper_key
              AND IFNULL(c.chunk_role, 'child') = 'child'
              AND IFNULL(c.section, '') != '参考文献'
              AND NOT EXISTS (
                SELECT 1 FROM search_records r
                WHERE r.source_key = c.chunk_key AND r.source_type IN ('paper_chunk', 'patent_chunk')
              )
          )
        )
      ORDER BY p.paper_key
    `);

  const paperKeys = forceAll
    ? allKeys("SELECT paper_key AS k FROM paper_documents WHERE paper_key NOT LIKE 'patent:%' ORDER BY paper_key")
    : allKeys(`
      SELECT p.paper_key AS k
      FROM paper_documents p
      WHERE p.paper_key NOT LIKE 'patent:%'
        AND (
          NOT EXISTS (
            SELECT 1 FROM search_records r
            WHERE r.source_key = p.paper_key AND r.source_type = 'paper'
          )
          OR EXISTS (
            SELECT 1 FROM paper_chunks c
            WHERE c.paper_key = p.paper_key
              AND IFNULL(c.chunk_role, 'child') = 'child'
              AND IFNULL(c.section, '') != '参考文献'
              AND NOT EXISTS (
                SELECT 1 FROM search_records r
                WHERE r.source_key = c.chunk_key AND r.source_type = 'paper_chunk'
              )
          )
        )
      ORDER BY p.paper_key
    `);

  const mentorKeys = forceAll
    ? allKeys('SELECT mentor_key AS k FROM mentor_profiles ORDER BY mentor_key')
    : allKeys(`
      SELECT m.mentor_key AS k
      FROM mentor_profiles m
      WHERE NOT EXISTS (
        SELECT 1 FROM search_records r
        WHERE r.source_key = m.mentor_key AND r.source_type = 'mentor'
      )
      ORDER BY m.mentor_key
    `);

  const totalAll = patentKeys.length + paperKeys.length + mentorKeys.length;
  const t0 = Date.now();
  console.log(`need patents=${patentKeys.length} batch=${patentBatch}`);
  console.log(`need papers=${paperKeys.length} batch=${paperBatch}`);
  console.log(`need mentors=${mentorKeys.length} batch=${mentorBatch}`);
  console.log(`total=${totalAll}`);

  if (!totalAll) {
    updateImportJobState({ status: 'done', phase: 'done', message: '无需补齐，索引已完整' });
    console.log(JSON.stringify({ ok: true, skipped: true }, null, 2));
    return;
  }

  let done = 0;
  done += await runBatches('专利', patentKeys, patentBatch, 'paper', done, totalAll, t0);
  done += await runBatches('论文', paperKeys, paperBatch, 'paper', done, totalAll, t0);
  done += await runBatches('导师', mentorKeys, mentorBatch, 'mentor', done, totalAll, t0);

  const summary = await persistDbSummary({ includeSlowCounts: false });
  updateImportJobState({
    status: 'done',
    phase: 'done',
    message: '增量索引补齐完成',
    progress: { current: totalAll, total: totalAll },
    result: {
      patents: patentKeys.length,
      papers: paperKeys.length,
      mentors: mentorKeys.length,
      elapsedMs: Date.now() - t0,
      indexStats: summary.indexStats
    }
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        elapsedMs: Date.now() - t0,
        patents: patentKeys.length,
        papers: paperKeys.length,
        mentors: mentorKeys.length,
        searchRecords: summary.indexStats.searchRecords,
        searchTerms: summary.indexStats.searchTerms
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  updateImportJobState({
    status: 'error',
    phase: 'error',
    message: '增量索引补齐失败',
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
