/**
 * 导入：数据/国重项目信息 → storage/parsed/nkrd + knowledge-corpus/national-projects
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataRootDir } from '../src/lib/config';
import { resolveDataSubdirs } from '../src/lib/data-dirs';
import { ingestNkrdProjects } from '../src/lib/nkrd-ingest';
import { getParsedNkrdDir } from '../src/lib/nkrd-markdown';
import { getCorpusRoot, corpusDirectory } from '../src/lib/corpus/schema';
import { updateImportJobState, resetImportJobState } from '../src/lib/import-state';

async function main() {
  const root = process.argv[2] || getDataRootDir();
  const subdirs = resolveDataSubdirs(root);
  resetImportJobState();
  updateImportJobState({
    status: 'running',
    phase: 'nkrd',
    message: '正在导入国重项目信息…',
    rootDir: root,
    startedAt: new Date().toISOString()
  });

  console.log('数据根:', root);
  console.log('国重目录:', subdirs.nkrd);
  console.log('解析后目录:', getParsedNkrdDir());
  console.log('语料目录:', path.join(getCorpusRoot(), corpusDirectory('nkrd')));

  const result = await ingestNkrdProjects({
    root: subdirs.nkrd,
    exportCorpus: true,
    rebuildIndex: true,
    onProgress: (current, total, filePath) => {
      const name = path.basename(filePath);
      console.log(`[国重 ${current}/${total}] ${name}`);
      updateImportJobState({
        phase: 'nkrd',
        message: `正在导入国重 (${current}/${total})：${name}`,
        progress: { current, total }
      });
    }
  });

  const parsedCount = fs.existsSync(getParsedNkrdDir())
    ? fs.readdirSync(getParsedNkrdDir()).filter((n) => n.endsWith('.md')).length
    : 0;
  const corpusDir = path.join(getCorpusRoot(), corpusDirectory('nkrd'));
  const corpusCount = fs.existsSync(corpusDir)
    ? fs.readdirSync(corpusDir).filter((n) => n.endsWith('.md')).length
    : 0;
  const manifest = fs.readFileSync(path.join(getCorpusRoot(), 'MANIFEST.md'), 'utf8');
  const nkrdLine = (manifest.match(/^- \*\*nkrd:\*\* \d+/m) || [])[0] || null;

  const summary = {
    ...result,
    parsedCount,
    corpusCount,
    nkrdLine
  };

  updateImportJobState({
    status: 'done',
    phase: 'done',
    message: '国重项目导入完成',
    result: summary
  });

  console.log('\n=== 完成 ===');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  updateImportJobState({
    status: 'error',
    phase: 'error',
    message: '国重导入失败',
    error: error instanceof Error ? error.message : String(error)
  });
  console.error(error);
  process.exit(1);
});
