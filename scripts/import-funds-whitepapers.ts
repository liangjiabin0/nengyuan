/**
 * 仅导入：基金信息（拆条 Markdown → storage/parsed/funds）+ 白皮书 PDF
 * 不跑论文/专利全量，避免长时间阻塞。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataRootDir } from '../src/lib/config';
import { resolveDataSubdirs } from '../src/lib/data-dirs';
import { ingestExcelAndCsv } from '../src/lib/excel-ingest';
import { ingestPaperDirectory } from '../src/lib/papers';
import { applyFastImportEnv } from '../src/lib/fast-import';
import { indexDocumentsFast } from '../src/lib/doc-index';
import { exportParsedFundMarkdown, getParsedFundsDir } from '../src/lib/fund-markdown';
import { syncPaperDocumentsToCorpus } from '../src/lib/corpus/export';
import { getDb, persistDbSummary, withTransaction } from '../src/lib/db';
import { indexProjectInDb } from '../src/lib/search-index';
import { syncFtsFromSearchRecords } from '../src/lib/fts-index';
import { getCorpusRoot, corpusDirectory, CORPUS_FORMAT, CORPUS_VERSION, type CorpusKind } from '../src/lib/corpus/schema';
import { updateImportJobState, resetImportJobState } from '../src/lib/import-state';

function patchManifest(countsPatch: Partial<Record<CorpusKind, number>>) {
  const root = getCorpusRoot();
  const manifestPath = path.join(root, 'MANIFEST.md');
  fs.mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  let text = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
  if (!text) {
    const counts = {
      person: 0,
      mentor: 0,
      paper: 0,
      patent: 0,
      whitepaper: 0,
      project: 0,
      output: 0,
      ...countsPatch
    };
    text = [
      '---',
      'record_key: "corpus-manifest"',
      'kind: "manifest"',
      `format: "${CORPUS_FORMAT}"`,
      `version: ${CORPUS_VERSION}`,
      `exported_at: ${JSON.stringify(now)}`,
      'total_records: 0',
      '---',
      '',
      '# Knowledge Corpus Manifest',
      '',
      '此目录由数据库自动导出。问答时只读取本目录，不直接查询数据库。',
      '',
      '## Record Counts',
      '',
      ...Object.entries(counts).map(([kind, n]) => `- **${kind}:** ${n}`)
    ].join('\n');
  }
  for (const [kind, value] of Object.entries(countsPatch)) {
    if (value === undefined) continue;
    const re = new RegExp(`^(- \\*\\*${kind}:\\*\\* )\\d+$`, 'm');
    if (re.test(text)) text = text.replace(re, `$1${value}`);
    else text += `\n- **${kind}:** ${value}`;
  }
  // outputs 始终保持 0：成果已并入项目 Markdown
  if (!/^- \*\*output:\*\* /m.test(text)) text += '\n- **output:** 0';
  else text = text.replace(/^(- \*\*output:\*\* )\d+$/m, '$10');
  fs.writeFileSync(manifestPath, `${text.trim()}\n`, 'utf8');
}

async function indexAllProjects() {
  return withTransaction(async (db) => {
    const projects = db.prepare('SELECT * FROM projects').all() as Array<Record<string, unknown> & { project_key: string }>;
    for (const project of projects) indexProjectInDb(db, project);
    return projects.length;
  }, true).then(async (count) => {
    syncFtsFromSearchRecords();
    return count;
  });
}

async function main() {
  const root = process.argv[2] || getDataRootDir();
  const subdirs = resolveDataSubdirs(root);
  applyFastImportEnv({ fast: true, concurrency: 4, skipCaj: true });
  process.env.SKIP_CAJ_CONVERT = '1';

  resetImportJobState();
  updateImportJobState({
    status: 'running',
    phase: 'funds',
    message: '正在导入基金信息并拆成单条 Markdown…',
    rootDir: root,
    startedAt: new Date().toISOString()
  });

  console.log('数据根:', root);
  console.log('基金目录:', subdirs.funds);
  console.log('白皮书目录:', subdirs.whitepapers);
  console.log('解析后目录:', getParsedFundsDir());

  // Force re-read of fund CSVs: ingestExcelAndCsv skips unchanged file_hash+row_count.
  // Without clearing source_files, updated 数据/基金信息 would leave stale projects/markdown.
  console.log('\n=== 0/4 清除基金 source_files 以便全量重导 ===');
  const fundNames = new Set(
    fs
      .readdirSync(subdirs.funds)
      .filter((name) => /\.(csv|xlsx|xls)$/i.test(name))
      .map((name) => name.toLowerCase())
  );
  const clearedSources = await withTransaction(async (db) => {
    const rows = db.prepare('SELECT id, filename FROM source_files').all() as Array<{ id: number; filename: string }>;
    const ids = rows.filter((row) => fundNames.has(String(row.filename || '').toLowerCase())).map((row) => row.id);
    const delRaw = db.prepare('DELETE FROM raw_records WHERE source_file_id = ?');
    const delSource = db.prepare('DELETE FROM source_files WHERE id = ?');
    for (const id of ids) {
      delRaw.run(id);
      delSource.run(id);
    }
    // Drop existing NSFC fund rows only — keep nkrd:* national key projects.
    db.exec(`
      DELETE FROM search_terms
      WHERE record_id IN (
        SELECT record_id FROM search_records
        WHERE source_type IN ('project', 'output')
          AND source_key NOT LIKE 'nkrd:%'
      );
      DELETE FROM search_records
      WHERE source_type IN ('project', 'output')
        AND source_key NOT LIKE 'nkrd:%';
      DELETE FROM outputs WHERE project_key NOT LIKE 'nkrd:%';
      DELETE FROM projects WHERE project_key NOT LIKE 'nkrd:%';
    `);
    return ids.length;
  });
  console.log('cleared fund source_files:', clearedSources);

  console.log('\n=== 1/4 导入基金 CSV ===');
  const funds = await ingestExcelAndCsv({
    roots: [subdirs.funds],
    rebuildIndex: false,
    crossLink: false,
    exportCorpus: false,
    linkEntities: false,
    onProgress: (current, total, filePath) => {
      const name = path.basename(filePath);
      console.log(`[基金 ${current}/${total}] ${name}`);
      updateImportJobState({
        phase: 'funds',
        message: `正在导入基金 (${current}/${total})：${name}`,
        progress: { current, total }
      });
    }
  });
  console.log(
    JSON.stringify(
      {
        scannedFiles: funds.scannedFiles,
        projects: funds.projects,
        outputs: funds.outputs,
        parsedFunds: funds.parsedFunds,
        importedSheets: funds.diagnostics.importedSheets,
        skippedSheets: funds.diagnostics.skippedSheets,
        headerMismatches: funds.diagnostics.headerMismatches.slice(0, 5)
      },
      null,
      2
    )
  );

  const corpusProjectsDir = path.join(getCorpusRoot(), corpusDirectory('project'));
  const parsed = exportParsedFundMarkdown(getDb(), { corpusProjectsDir });
  patchManifest({ project: parsed.written, output: 0 });
  console.log('解析后基金 Markdown:', parsed);

  updateImportJobState({ phase: 'whitepapers', message: '正在导入白皮书 PDF…' });
  console.log('\n=== 2/4 导入白皮书 ===');
  const whitepapers = await ingestPaperDirectory(subdirs.whitepapers, { keyPrefix: 'whitepaper:' });
  console.log(
    JSON.stringify(
      {
        dir: whitepapers.dir,
        files: whitepapers.files,
        imported: whitepapers.imported,
        failed: whitepapers.failed,
        skipped: whitepapers.skipped,
        changedKeys: (whitepapers.changedKeys || []).slice(0, 10)
      },
      null,
      2
    )
  );

  // Agent reads local Markdown only — always sync whitepaper full text out of SQLite.
  const whitepaperCorpus = syncPaperDocumentsToCorpus(getDb(), {
    paperKeys: whitepapers.changedKeys?.length
      ? whitepapers.changedKeys
      : undefined,
    keyPrefix: whitepapers.changedKeys?.length ? undefined : 'whitepaper:'
  });
  console.log('白皮书语料已导出:', whitepaperCorpus);

  updateImportJobState({ phase: 'indexing', message: '正在对齐知识图谱（轻量跳过，基金已拆条入库）…' });
  console.log('\n=== 3/4 知识图谱对齐（跳过：避免 36 万实体扫描过慢）===');
  const crossLink = { skipped: true, reason: 'fund bulk import uses linkEntities=false; searchable markdown is primary' };
  console.log(JSON.stringify(crossLink, null, 2));

  updateImportJobState({ phase: 'indexing', message: '正在更新检索索引…' });
  console.log('\n=== 4/4 检索索引 ===');
  const projectIndexed = await indexAllProjects();
  const docs = await indexDocumentsFast({
    paperKeys: whitepapers.changedKeys || [],
    fillMissing: false
  });
  await persistDbSummary({ includeSlowCounts: true });

  const parsedDir = getParsedFundsDir();
  const parsedCount = fs.existsSync(parsedDir)
    ? fs.readdirSync(parsedDir).filter((name) => name.toLowerCase().endsWith('.md')).length
    : 0;
  const corpusProjectCount = fs.existsSync(corpusProjectsDir)
    ? fs.readdirSync(corpusProjectsDir).filter((name) => name.endsWith('.md')).length
    : 0;
  const corpusOutputs = path.join(getCorpusRoot(), 'outputs');
  const corpusOutputCount = fs.existsSync(corpusOutputs)
    ? fs.readdirSync(corpusOutputs).filter((name) => name.endsWith('.md')).length
    : 0;

  const result = {
    funds: {
      scannedFiles: funds.scannedFiles,
      projects: funds.projects,
      outputsInDb: funds.outputs,
      parsedMarkdown: parsedCount,
      parsedDir,
      corpusProjects: corpusProjectCount,
      corpusOutputs: corpusOutputCount,
      projectIndexed
    },
    whitepapers: {
      files: whitepapers.files,
      imported: whitepapers.imported,
      failed: whitepapers.failed,
      docs
    },
    crossLink
  };

  updateImportJobState({
    status: 'done',
    phase: 'done',
    message: '基金+白皮书导入完成',
    result
  });

  console.log('\n=== 完成 ===');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  updateImportJobState({
    status: 'error',
    phase: 'error',
    message: '导入失败',
    error: error instanceof Error ? error.message : String(error)
  });
  console.error(error);
  process.exit(1);
});
