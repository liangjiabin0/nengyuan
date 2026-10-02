/**
 * 补齐缺口：CAJ→PDF（保留 CAJ）→ 入库论文 → 补导师 → 增量索引
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataRootDir } from '../src/lib/config';
import { resolveDataSubdirs } from '../src/lib/data-dirs';
import { applyFastImportEnv } from '../src/lib/fast-import';
import { convertCajToPdf, ingestPaperDirectory, listCajFiles } from '../src/lib/papers';
import { ingestMentorDirectory } from '../src/lib/mentors';
import { indexDocumentsFast } from '../src/lib/doc-index';
import { rebuildSearchIndex } from '../src/lib/search-index';
import { persistDbSummary } from '../src/lib/db';
import { updateImportJobState, resetImportJobState } from '../src/lib/import-state';

async function main() {
  const fullRebuild = process.env.FULL_REBUILD_INDEX === '1';
  const fastOpts = applyFastImportEnv({
    fast: true,
    fullRebuild,
    skipCaj: process.env.SKIP_CAJ_CONVERT === '1'
  });
  const root = process.argv[2] || getDataRootDir();
  const subdirs = resolveDataSubdirs(root);
  resetImportJobState();
  updateImportJobState({
    status: 'running',
    phase: 'converting',
    message: `开始补齐缺口（并发 ${fastOpts.concurrency}）…`,
    rootDir: root,
    startedAt: new Date().toISOString()
  });

  const cajFiles = listCajFiles(subdirs.papers);
  const skipConvert = process.env.SKIP_CAJ_CONVERT === '1';
  console.log(`CAJ 待转换: ${skipConvert ? 0 : cajFiles.length} (skipConvert=${skipConvert}) concurrency=${fastOpts.concurrency}`);
  let converted = 0;
  let reused = 0;
  let failed = 0;
  const failSamples: string[] = [];

  if (!skipConvert) {
    for (let i = 0; i < cajFiles.length; i += 1) {
      const file = cajFiles[i];
      updateImportJobState({
        phase: 'converting',
        message: `转换 CAJ (${i + 1}/${cajFiles.length})：${path.basename(file)}`,
        progress: { current: i + 1, total: cajFiles.length }
      });
      try {
        const result = convertCajToPdf(file, { deleteSource: false });
        if (result.converted) converted += 1;
        else reused += 1;
        if ((i + 1) % 20 === 0 || i === cajFiles.length - 1) {
          console.log(`convert ${i + 1}/${cajFiles.length} ok=${converted} reuse=${reused} fail=${failed}`);
        }
      } catch (error) {
        failed += 1;
        if (failSamples.length < 15) {
          failSamples.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  const pdfDir = path.join(subdirs.papers, 'pdf');
  const cajDir = path.join(subdirs.papers, 'caj');
  fs.mkdirSync(pdfDir, { recursive: true });
  let moved = 0;
  if (fs.existsSync(cajDir)) {
    for (const name of fs.readdirSync(cajDir)) {
      if (!name.toLowerCase().endsWith('.pdf')) continue;
      const from = path.join(cajDir, name);
      const to = path.join(pdfDir, name);
      if (!fs.existsSync(to)) {
        fs.renameSync(from, to);
        moved += 1;
      }
    }
  }
  console.log(`moved pdf from caj/ -> pdf/: ${moved}`);

  updateImportJobState({ phase: 'papers', message: '导入论文 PDF…' });
  process.env.SKIP_CAJ_CONVERT = '1';
  (global as typeof globalThis & { __paperIngestProgress?: (c: number, t: number, f: string) => void }).__paperIngestProgress = (
    current,
    total,
    filePath
  ) => {
    if (current === 1 || current === total || current % 25 === 0) {
      console.log(`papers progress ${current}/${total} ${path.basename(filePath)}`);
    }
    updateImportJobState({
      phase: 'papers',
      message: `导入论文 PDF (${current}/${total})：${path.basename(filePath)}`,
      progress: { current, total }
    });
  };
  const papers = await ingestPaperDirectory(subdirs.papers);
  console.log(
    `papers imported=${papers.imported} failed=${papers.failed} files=${papers.files} skipped=${papers.skipped ?? 0} changed=${papers.changedKeys?.length ?? 0}`
  );

  updateImportJobState({ phase: 'mentors', message: '补齐导师…' });
  const mentors = await ingestMentorDirectory(subdirs.mentors);
  console.log(
    `mentors imported=${mentors.imported} failed=${mentors.failed} files=${mentors.files} skipped=${mentors.skipped ?? 0} changed=${mentors.changedKeys?.length ?? 0}`
  );

  updateImportJobState({
    phase: 'indexing',
    message: fullRebuild ? '全量重建检索索引…' : '文档级检索索引…'
  });
  const index = fullRebuild
    ? await rebuildSearchIndex()
    : await indexDocumentsFast({
        paperKeys: papers.changedKeys || [],
        mentorKeys: mentors.changedKeys || [],
        fillMissing: true
      });
  const summary = await persistDbSummary({ includeSlowCounts: false });

  updateImportJobState({
    status: 'done',
    phase: 'done',
    message: '缺口补齐完成',
    progress: { current: cajFiles.length, total: cajFiles.length },
    result: { converted, reused, failed, moved, papers, mentors, index, summary, concurrency: fastOpts.concurrency }
  });

  console.log(
    JSON.stringify(
      {
        convert: { total: cajFiles.length, converted, reused, failed, failSamples },
        moved,
        concurrency: fastOpts.concurrency,
        papers: {
          files: papers.files,
          imported: papers.imported,
          failed: papers.failed,
          skipped: papers.skipped,
          changed: papers.changedKeys?.length
        },
        mentors: {
          files: mentors.files,
          imported: mentors.imported,
          failed: mentors.failed,
          skipped: mentors.skipped,
          changed: mentors.changedKeys?.length
        },
        index,
        db: {
          papers: summary.papers,
          patents: summary.patents,
          mentors: summary.mentors,
          disk: summary.disk,
          searchTerms: summary.indexStats.searchTerms
        }
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
    message: '缺口补齐失败',
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
