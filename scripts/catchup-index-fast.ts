/**
 * 文档级索引补齐（默认推荐策略）。
 * INDEX_DOCS_ONLY=0 时额外补论文分块（较慢）。
 */
import { indexDocumentsFast } from '../src/lib/doc-index';
import { getDb, persistDbSummary } from '../src/lib/db';
import { indexSourcesIncremental } from '../src/lib/search-index';
import { resetImportJobState, updateImportJobState } from '../src/lib/import-state';

async function main() {
  const docsOnly = process.env.INDEX_DOCS_ONLY !== '0';
  resetImportJobState();
  updateImportJobState({
    status: 'running',
    phase: 'indexing',
    message: '文档级索引补齐…',
    startedAt: new Date().toISOString()
  });

  const t0 = Date.now();
  const docs = await indexDocumentsFast({ fillMissing: true });

  let paperChunkKeys = 0;
  if (!docsOnly) {
    process.env.INDEX_FTS_ONLY = '1';
    process.env.SEARCH_INDEX_SYNC_FTS = '1';
    const paperKeys = (
      getDb()
        .prepare(
          `SELECT DISTINCT c.paper_key AS k
           FROM paper_chunks c
           JOIN paper_documents p ON p.paper_key = c.paper_key
           WHERE p.paper_key NOT LIKE 'patent:%'
             AND IFNULL(c.chunk_role,'child') = 'child'
             AND IFNULL(c.section,'') != '参考文献'
             AND NOT EXISTS (
               SELECT 1 FROM search_records r
               WHERE r.source_key = c.chunk_key AND r.source_type = 'paper_chunk'
             )`
        )
        .all() as Array<{ k: string }>
    ).map((row) => row.k);

    updateImportJobState({
      phase: 'indexing',
      message: `补论文分块 ${paperKeys.length} 篇…`,
      progress: { current: 0, total: paperKeys.length || 1 }
    });

    for (let i = 0; i < paperKeys.length; i += 8) {
      const slice = paperKeys.slice(i, i + 8);
      await indexSourcesIncremental({ paperKeys: slice });
      paperChunkKeys = Math.min(i + slice.length, paperKeys.length);
      if (paperChunkKeys % 40 === 0 || paperChunkKeys === paperKeys.length) {
        process.stdout.write(`paper chunks ${paperChunkKeys}/${paperKeys.length}\n`);
      }
      updateImportJobState({
        phase: 'indexing',
        message: `索引论文分块 ${paperChunkKeys}/${paperKeys.length}`,
        progress: { current: paperChunkKeys, total: paperKeys.length || 1 }
      });
    }
  }

  const summary = await persistDbSummary({ includeSlowCounts: false });
  updateImportJobState({
    status: 'done',
    phase: 'done',
    message: docsOnly ? '文档级索引补齐完成' : '文档+分块索引补齐完成',
    progress: { current: 1, total: 1 },
    result: { ...docs, paperChunkKeys, elapsedMs: Date.now() - t0, indexStats: summary.indexStats }
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        docsOnly,
        elapsedMs: Date.now() - t0,
        ...docs,
        paperChunkKeys,
        searchRecords: summary.indexStats.searchRecords
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
    message: '索引补齐失败',
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
