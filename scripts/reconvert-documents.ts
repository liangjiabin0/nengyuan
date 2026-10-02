/**
 * 从数据目录源文件只读重转 PDF/CAJ → 入库 → 同步 knowledge-corpus。
 * 不修改 数据/ 下任何源文件。CAJ 转换与 OCR 缓存写入 storage/convert-work。
 *
 *   npx tsx scripts/reconvert-documents.ts --kind samples --force
 *   npx tsx scripts/reconvert-documents.ts --kind whitepapers --force
 *   npx tsx scripts/reconvert-documents.ts --kind papers --limit 50 --resume
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataRootDir } from '../src/lib/config';
import { resolveDataSubdirs } from '../src/lib/data-dirs';
import { ingestPaperFile, listPaperFiles } from '../src/lib/papers';
import { getConvertWorkDir, isPdf2mdAvailable } from '../src/lib/pdf2md';
import { getDb } from '../src/lib/db';
import { syncPaperDocumentsToCorpus } from '../src/lib/corpus/export';

type Kind = 'whitepapers' | 'papers' | 'all' | 'samples';

type ProgressFile = {
  kind: string;
  done: string[];
  failed: Array<{ path: string; error: string }>;
  imported: string[];
  updatedAt: string;
};

const SAMPLE_PAPER_HINTS = [
  '同调特性分析_郑乐',
  '碳排放核算标准对比分析_易俊',
  '多源局部放电定位方法_关宇',
  '灵活动态锁频环',
  '故障概率'
];

function parseArgs(argv: string[]) {
  const args = {
    kind: 'samples' as Kind,
    limit: 0,
    force: false,
    resume: false,
    copy: false,
    glob: '',
    concurrency: 0
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--kind') args.kind = String(argv[++i] || 'samples') as Kind;
    else if (token === '--limit') args.limit = Number(argv[++i] || 0) || 0;
    else if (token === '--force') args.force = true;
    else if (token === '--resume') args.resume = true;
    else if (token === '--copy') args.copy = true;
    else if (token === '--glob') args.glob = String(argv[++i] || '');
    else if (token === '--concurrency') args.concurrency = Number(argv[++i] || 0) || 0;
  }
  if (!['whitepapers', 'papers', 'all', 'samples'].includes(args.kind)) {
    throw new Error(`未知 --kind：${args.kind}`);
  }
  return args;
}

function progressPath() {
  return path.join(getConvertWorkDir(), 'progress.json');
}

function loadProgress(kind: string, resume: boolean): ProgressFile {
  const empty: ProgressFile = { kind, done: [], failed: [], imported: [], updatedAt: new Date().toISOString() };
  if (!fs.existsSync(progressPath())) return empty;
  try {
    const parsed = JSON.parse(fs.readFileSync(progressPath(), 'utf8')) as ProgressFile;
    return {
      kind,
      done: Array.isArray(parsed.done) ? [...new Set(parsed.done)] : [],
      failed: resume && Array.isArray(parsed.failed) ? parsed.failed : [],
      imported: Array.isArray(parsed.imported) ? [...new Set(parsed.imported)] : [],
      updatedAt: parsed.updatedAt || empty.updatedAt
    };
  } catch {
    return empty;
  }
}

function saveProgress(progress: ProgressFile) {
  fs.mkdirSync(getConvertWorkDir(), { recursive: true });
  progress.done = [...new Set(progress.done)];
  progress.imported = [...new Set(progress.imported)];
  progress.updatedAt = new Date().toISOString();
  fs.writeFileSync(progressPath(), `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
}

function copyToWork(src: string, kind: string) {
  const destDir = path.join(getConvertWorkDir(), 'copies', kind);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  fs.copyFileSync(src, dest);
  return dest;
}

function listWhitepapers(dir: string) {
  return listPaperFiles(dir).filter((file) => path.extname(file).toLowerCase() === '.pdf');
}

function listSamplePapers(papersDir: string) {
  const all = listPaperFiles(papersDir).filter((file) => path.extname(file).toLowerCase() === '.pdf');
  const picked: string[] = [];
  for (const hint of SAMPLE_PAPER_HINTS) {
    const hit = all.find((file) => path.basename(file).includes(hint));
    if (hit && !picked.includes(hit)) picked.push(hit);
  }
  for (const file of all) {
    if (picked.length >= 5) break;
    if (!picked.includes(file)) picked.push(file);
  }
  return picked.slice(0, 5);
}

function normalizePaperStem(file: string) {
  return path
    .basename(file, path.extname(file))
    .replace(/\s*\(\d+\)$/, '')
    .toLowerCase();
}

function dedupeCajWhenPdfExists(files: string[]) {
  const pdfs = files.filter((file) => path.extname(file).toLowerCase() === '.pdf');
  const pdfStems = new Set(pdfs.map(normalizePaperStem));
  const cajs = files.filter((file) => {
    if (path.extname(file).toLowerCase() !== '.caj') return false;
    return !pdfStems.has(normalizePaperStem(file));
  });
  return [...pdfs, ...cajs];
}

function collectFiles(kind: Kind, rootKindLimit: { papers?: number; glob?: string }) {
  const subdirs = resolveDataSubdirs(getDataRootDir());
  const files: Array<{ file: string; keyPrefix: string; copyKind: string }> = [];
  if (kind === 'samples') {
    for (const file of listSamplePapers(subdirs.papers)) {
      files.push({ file, keyPrefix: 'paper:', copyKind: 'papers' });
    }
  }
  if (kind === 'whitepapers' || kind === 'all' || kind === 'samples') {
    for (const file of listWhitepapers(subdirs.whitepapers)) {
      files.push({ file, keyPrefix: 'whitepaper:', copyKind: 'whitepapers' });
    }
  }
  if (kind === 'papers' || kind === 'all') {
    let papers = dedupeCajWhenPdfExists(listPaperFiles(subdirs.papers));
    if (rootKindLimit.glob) {
      const re = new RegExp(rootKindLimit.glob);
      papers = papers.filter((file) => re.test(path.basename(file)));
    }
    if (rootKindLimit.papers && rootKindLimit.papers > 0) papers = papers.slice(0, rootKindLimit.papers);
    for (const file of papers) files.push({ file, keyPrefix: 'paper:', copyKind: 'papers' });
  }
  return files;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.DATA_IMPORT_READONLY = '1';
  process.env.SKIP_EXISTING_PAPERS = args.force ? '0' : process.env.SKIP_EXISTING_PAPERS || '0';
  if (args.force) {
    process.env.FORCE_REINGEST = '1';
    if (!args.resume) process.env.FORCE_PDF2MD = process.env.FORCE_PDF2MD || '1';
  }
  const concurrency = Math.max(1, Math.min(4, args.concurrency || Number(process.env.PAPER_INGEST_CONCURRENCY || 2) || 2));
  process.env.PAPER_INGEST_CONCURRENCY = String(concurrency);

  if (!isPdf2mdAvailable()) {
    throw new Error('pdf2md 不可用：请先创建 tools/pdf2md-venv 并安装 tools/pdf2md/requirements.txt');
  }

  const shouldCopy = args.copy || args.kind === 'whitepapers' || args.kind === 'samples';
  const selected = collectFiles(args.kind, { papers: args.kind === 'all' ? args.limit : args.limit, glob: args.glob });
  const files = args.limit > 0 ? selected.slice(0, args.limit) : selected;
  const progress = loadProgress(args.kind, args.resume);
  const doneSet = new Set(progress.done.map((item) => path.resolve(item).toLowerCase()));
  const pending = files.filter((item) => !(args.resume && doneSet.has(path.resolve(item.file).toLowerCase())));

  console.log(
    JSON.stringify(
      {
        kind: args.kind,
        files: files.length,
        pending: pending.length,
        skipped: files.length - pending.length,
        force: args.force,
        resume: args.resume,
        copy: shouldCopy,
        concurrency,
        pdf2md: true,
        workDir: getConvertWorkDir(),
        parsedDir: path.join(process.cwd(), 'storage', 'parsed', 'papers')
      },
      null,
      2
    )
  );

  const importedKeys: string[] = [];
  let processed = 0;
  let cursor = 0;
  let writeChain = Promise.resolve();

  function enqueueProgress(mutator: () => void) {
    writeChain = writeChain.then(() => {
      mutator();
      saveProgress(progress);
    });
    return writeChain;
  }

  async function flushParsed(keys: string[]) {
    const unique = [...new Set(keys.filter(Boolean))];
    if (!unique.length) return;
    const corpus = syncPaperDocumentsToCorpus(getDb(), { paperKeys: unique });
    console.log(`corpus/parsed synced written=${corpus.written} parsed=${corpus.parsedWritten}`);
  }

  async function worker() {
    const pendingSync: string[] = [];
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) {
        await flushParsed(pendingSync.splice(0, pendingSync.length));
        return;
      }
      const item = pending[index];
      const resolved = path.resolve(item.file);
      const workFile = shouldCopy ? copyToWork(item.file, item.copyKind) : item.file;
      processed += 1;
      console.log(`[convert] ${processed}/${pending.length} ${path.basename(item.file)}`);
      try {
        const result = await ingestPaperFile(workFile, {
          keyPrefix: item.keyPrefix,
          force: args.force,
          originalPath: item.file
        });
        importedKeys.push(result.paperKey);
        pendingSync.push(result.paperKey);
        await enqueueProgress(() => {
          progress.done.push(resolved);
          progress.imported.push(result.paperKey);
          progress.failed = progress.failed.filter((row) => path.resolve(row.path).toLowerCase() !== resolved.toLowerCase());
        });
        console.log(
          `  ok key=${result.paperKey} pages=${result.pageCount} chunks=${result.chunks} method=${result.convertMethod}`
        );
        if (pendingSync.length >= 5) await flushParsed(pendingSync.splice(0, pendingSync.length));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await enqueueProgress(() => {
          progress.failed.push({ path: resolved, error: message });
        });
        console.error(`  fail ${path.basename(item.file)}: ${message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length || 1) }, () => worker()));
  await writeChain;

  const keys = [...new Set([...importedKeys, ...progress.imported].filter(Boolean))];
  if (keys.length) {
    const corpus = syncPaperDocumentsToCorpus(getDb(), { paperKeys: keys });
    console.log(`corpus synced written=${corpus.written} parsed=${corpus.parsedWritten}`);
  }
  saveProgress(progress);
  console.log(`progress: ${progressPath()}`);
  console.log(`failed: ${progress.failed.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
