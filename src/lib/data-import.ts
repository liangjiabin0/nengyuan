import fs from 'node:fs';
import { resolveDataSubdirs, listMentorZipCandidates } from './data-dirs';
import { getDataRootDir } from './config';
import {
  getImportJobState,
  isImportJobRunning,
  resetImportJobState,
  setActiveImportJob,
  updateImportJobState
} from './import-state';
import { convertCajFilesInDirectory, ingestPaperDirectory, listCajFiles, listPaperFiles } from './papers';
import { ingestPatentMarkdownDirectory } from './patents';
import { extractMentorZip, ingestMentorDirectory } from './mentors';
import { ingestExcelAndCsv } from './excel-ingest';
import { ingestNkrdProjects } from './nkrd-ingest';
import { indexSourcesIncremental, rebuildSearchIndex } from './search-index';
import { indexDocumentsFast } from './doc-index';
import { crossLinkKnowledgeGraph } from './kg/cross-link';
import { applyFastImportEnv, type FastImportOptions } from './fast-import';
import { exportKnowledgeCorpus } from './corpus/export';
import { enqueueJob, hasActiveSerialJob, isJobQueueEnabled } from './jobs/queue';

export type DataImportResult = {
  rootDir: string;
  subdirs: ReturnType<typeof resolveDataSubdirs>;
  conversion: {
    papers: Awaited<ReturnType<typeof convertCajFilesInDirectory>>;
    patents: Awaited<ReturnType<typeof convertCajFilesInDirectory>>;
    books: Awaited<ReturnType<typeof convertCajFilesInDirectory>>;
  };
  mentorsExtracted: { zipPath: string; extracted: number } | null;
  papers: Awaited<ReturnType<typeof ingestPaperDirectory>>;
  patents: {
    dir: string;
    files: number;
    imported: number;
    failed: number;
    markdown: Awaited<ReturnType<typeof ingestPatentMarkdownDirectory>>;
    binary: Awaited<ReturnType<typeof ingestPaperDirectory>> | {
      dir: string;
      files: number;
      imported: number;
      failed: number;
      results: unknown[];
      errors: Array<{ filePath: string; error: string }>;
    };
  };
  books: Awaited<ReturnType<typeof ingestPaperDirectory>>;
  funds: Awaited<ReturnType<typeof ingestExcelAndCsv>> | {
    scannedFiles: number;
    scannedRoots: string[];
    importedSheets: unknown[];
    projects: number;
    outputs: number;
    skipped: true;
  };
  nkrd: Awaited<ReturnType<typeof ingestNkrdProjects>>;
  mentors: Awaited<ReturnType<typeof ingestMentorDirectory>>;
  index: Awaited<ReturnType<typeof rebuildSearchIndex>> | Awaited<ReturnType<typeof indexSourcesIncremental>> | Awaited<ReturnType<typeof indexDocumentsFast>>;
  crossLink?: Awaited<ReturnType<typeof crossLinkKnowledgeGraph>> | null;
  corpus: Awaited<ReturnType<typeof exportKnowledgeCorpus>>;
  fast?: boolean;
  concurrency?: number;
  indexMode?: 'docs' | 'chunks' | 'full';
};

export async function runDataImport(rootDir = getDataRootDir(), options: FastImportOptions = {}): Promise<DataImportResult> {
  const fastOpts = applyFastImportEnv(options);
  const subdirs = resolveDataSubdirs(rootDir);
  updateImportJobState({
    status: 'running',
    phase: 'preparing',
    message: fastOpts.fast
      ? `快速导入启动中（解析并发 ${fastOpts.concurrency}）…`
      : '正在准备数据目录...',
    rootDir,
    startedAt: new Date().toISOString(),
    progress: { current: 0, total: 0 }
  });

  let mentorsExtracted: DataImportResult['mentorsExtracted'] = null;
  const mentorLocalCorpus = process.env.MENTOR_LOCAL_CORPUS === '1';
  const mentorZips = listMentorZipCandidates(rootDir);
  const readonly = process.env.DATA_IMPORT_READONLY === '1';
  const mentorMdCount = fs.existsSync(subdirs.mentors)
    ? fs.readdirSync(subdirs.mentors).filter((name) => name.toLowerCase().endsWith('.md')).length
    : 0;
  if (mentorLocalCorpus && mentorZips.length && !readonly && mentorMdCount === 0) {
    updateImportJobState({ phase: 'mentors', message: '正在解压导师信息文档...' });
    const extracted = extractMentorZip(mentorZips[0], subdirs.mentors);
    mentorsExtracted = { zipPath: mentorZips[0], extracted: extracted.extracted };
  } else if (mentorLocalCorpus && (!fs.existsSync(subdirs.mentors) || !fs.readdirSync(subdirs.mentors).length)) {
    updateImportJobState({ message: readonly ? '只读导入：跳过导师压缩包解压。' : '未找到导师压缩包，将仅导入已有导师 Markdown 文件。' });
  }

  updateImportJobState({ phase: 'converting', message: '正在将 CAJ 转换为 PDF...' });
  const skipCaj = process.env.SKIP_CAJ_CONVERT === '1';
  const paperCajTotal = skipCaj ? 0 : listCajFiles(subdirs.papers).length;
  const patentCajTotal = skipCaj ? 0 : listCajFiles(subdirs.patents).length;
  const bookCajTotal = skipCaj ? 0 : listCajFiles(subdirs.books).length;
  const convertTotal = paperCajTotal + patentCajTotal + bookCajTotal;

  const emptyConversion = {
    dir: '',
    total: 0,
    converted: 0,
    deleted: 0,
    failed: 0,
    results: [] as Array<{ filePath: string; pdfPath?: string; converted: boolean; deletedCaj?: boolean; error?: string }>
  };

  const papersConverted = skipCaj
    ? { ...emptyConversion, dir: subdirs.papers }
    : convertCajFilesInDirectory(subdirs.papers, {
        deleteSource: false,
        onProgress: (current, total, filePath) => {
          updateImportJobState({
            message: `正在转换论文 CAJ (${current}/${total})：${filePath.split(/[\\/]/).pop()}`,
            progress: { current, total: convertTotal || total }
          });
        }
      });

  const patentsConverted = skipCaj
    ? { ...emptyConversion, dir: subdirs.patents }
    : convertCajFilesInDirectory(subdirs.patents, {
        deleteSource: false,
        onProgress: (current, total, filePath) => {
          updateImportJobState({
            message: `正在转换专利 CAJ (${current}/${total})：${filePath.split(/[\\/]/).pop()}`,
            progress: { current: paperCajTotal + current, total: convertTotal || paperCajTotal + total }
          });
        }
      });

  const booksConverted = skipCaj
    ? { ...emptyConversion, dir: subdirs.books }
    : convertCajFilesInDirectory(subdirs.books, {
        deleteSource: false,
        onProgress: (current, total, filePath) => {
          updateImportJobState({
            message: `正在转换书籍 CAJ (${current}/${total})：${filePath.split(/[\\/]/).pop()}`,
            progress: {
              current: paperCajTotal + patentCajTotal + current,
              total: convertTotal || paperCajTotal + patentCajTotal + total
            }
          });
        }
      });

  // 转换完成后只导入 PDF，避免重复解析 CAJ
  process.env.SKIP_CAJ_CONVERT = '1';

  updateImportJobState({
    phase: 'papers',
    message: `正在导入论文（并发 ${fastOpts.concurrency}）…`,
    progress: { current: 0, total: 0 }
  });
  (global as typeof globalThis & { __paperIngestProgress?: (c: number, t: number, f: string) => void }).__paperIngestProgress = (
    current,
    total,
    filePath
  ) => {
    updateImportJobState({
      phase: 'papers',
      message: `正在导入论文 (${current}/${total})：${filePath.split(/[\\/]/).pop()}`,
      progress: { current, total }
    });
  };
  const papers = await ingestPaperDirectory(subdirs.papers);

  updateImportJobState({ phase: 'patents', message: '正在导入专利...' });
  const patentsMd = await ingestPatentMarkdownDirectory(subdirs.patents);
  const patentBinaryFiles = listPaperFiles(subdirs.patents);
  const patentsBin = patentBinaryFiles.length > 0
    ? await ingestPaperDirectory(subdirs.patents, { keyPrefix: 'patent:' })
    : {
        dir: subdirs.patents,
        files: 0,
        imported: 0,
        failed: 0,
        skipped: 0,
        changedKeys: [] as string[],
        results: [],
        errors: [] as Array<{ filePath: string; error: string }>
      };
  const patents = {
    dir: subdirs.patents,
    files: Number(patentsMd.files || 0) + Number(patentsBin.files || 0),
    imported: Number(patentsMd.imported || 0) + Number(patentsBin.imported || 0),
    failed: Number(patentsMd.failed || 0) + Number(patentsBin.failed || 0),
    markdown: patentsMd,
    binary: patentsBin
  };

  updateImportJobState({
    phase: 'books',
    message: `正在导入书籍（并发 ${fastOpts.concurrency}）…`
  });
  (global as typeof globalThis & { __paperIngestProgress?: (c: number, t: number, f: string) => void }).__paperIngestProgress = (
    current,
    total,
    filePath
  ) => {
    updateImportJobState({
      phase: 'books',
      message: `正在导入书籍 (${current}/${total})：${filePath.split(/[\\/]/).pop()}`,
      progress: { current, total }
    });
  };
  const books = await ingestPaperDirectory(subdirs.books, { keyPrefix: 'book:' });

  updateImportJobState({ phase: 'funds', message: '正在导入基金/项目表...' });
  const funds = await ingestExcelAndCsv({
    roots: [subdirs.funds],
    rebuildIndex: false,
    crossLink: false,
    exportCorpus: false
  });

  updateImportJobState({ phase: 'nkrd', message: '正在导入国重项目信息...' });
  const nkrd = await ingestNkrdProjects({
    root: subdirs.nkrd,
    rebuildIndex: false,
    exportCorpus: false,
    onProgress: (current, total, filePath) => {
      updateImportJobState({
        phase: 'nkrd',
        message: `正在导入国重项目 (${current}/${total})：${filePath.split(/[\\/]/).pop()}`,
        progress: { current, total }
      });
    }
  });

  let mentors: DataImportResult['mentors'];
  if (mentorLocalCorpus) {
    updateImportJobState({ phase: 'mentors', message: '正在导入导师信息...' });
    mentors = await ingestMentorDirectory(subdirs.mentors);
  } else {
    updateImportJobState({
      phase: 'mentors',
      message: '导师档案已改走 SearXNG 互联网检索，跳过本地导师导入与索引。'
    });
    mentors = {
      dir: subdirs.mentors,
      files: 0,
      imported: 0,
      failed: 0,
      skipped: 0,
      results: [],
      errors: [],
      changedKeys: []
    };
  }

  let crossLink: DataImportResult['crossLink'] = null;
  if (!fastOpts.fast || fastOpts.crossLink) {
    updateImportJobState({ phase: 'indexing', message: '正在对齐知识图谱关系...' });
    crossLink = await crossLinkKnowledgeGraph();
  }

  updateImportJobState({
    phase: 'indexing',
    message: fastOpts.fullRebuild
      ? '正在全量重建检索索引...'
      : fastOpts.indexChunks
        ? '正在更新文档+分块检索索引...'
        : '正在更新文档级检索索引（推荐）...'
  });
  const paperKeys = [
    ...(papers.changedKeys || []),
    ...(patentsBin.changedKeys || []),
    ...(patentsMd.changedKeys || []),
    ...(books.changedKeys || [])
  ];
  const mentorKeys = mentors.changedKeys || [];

  let index: DataImportResult['index'];
  let indexMode: DataImportResult['indexMode'] = 'docs';
  if (fastOpts.fullRebuild) {
    index = await rebuildSearchIndex();
    indexMode = 'full';
  } else if (fastOpts.indexChunks) {
    // 先文档级，再对本轮变更做分块索引
    await indexDocumentsFast({ paperKeys, mentorKeys, fillMissing: true });
    process.env.INDEX_FTS_ONLY = '1';
    process.env.SEARCH_INDEX_SYNC_FTS = '1';
    index = await indexSourcesIncremental({ paperKeys, mentorKeys });
    indexMode = 'chunks';
  } else {
    index = await indexDocumentsFast({ paperKeys, mentorKeys, fillMissing: true });
    indexMode = 'docs';
  }

  updateImportJobState({
    phase: 'indexing',
    message: '正在生成能元 Markdown 语料...'
  });
  const corpus = await exportKnowledgeCorpus();

  const result: DataImportResult = {
    rootDir,
    subdirs,
    conversion: {
      papers: papersConverted,
      patents: patentsConverted,
      books: booksConverted
    },
    mentorsExtracted,
    papers,
    patents,
    books,
    funds,
    nkrd,
    mentors,
    index,
    crossLink,
    corpus,
    fast: fastOpts.fast,
    concurrency: fastOpts.concurrency,
    indexMode
  };

  updateImportJobState({
    status: 'done',
    phase: 'done',
    message: '数据导入完成',
    result,
    progress: { current: convertTotal, total: convertTotal }
  });

  return result;
}

export async function startDataImport(rootDir = getDataRootDir(), options: FastImportOptions = {}) {
  if (isImportJobRunning() || (isJobQueueEnabled() && await hasActiveSerialJob('data-import'))) {
    return { started: false as const, state: getImportJobState() };
  }

  resetImportJobState();
  updateImportJobState({
    status: 'running',
    phase: 'preparing',
    message: '正在启动导入任务...',
    rootDir,
    startedAt: new Date().toISOString()
  });

  if (isJobQueueEnabled()) {
    const backgroundJob = await enqueueJob('data-import', { rootDir, options });
    return { started: true as const, state: getImportJobState(), jobId: backgroundJob.id };
  }

  const job = runDataImport(rootDir, options)
    .catch((error) => {
      updateImportJobState({
        status: 'error',
        phase: 'error',
        message: '导入失败',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    })
    .finally(() => {
      setActiveImportJob(null);
    });

  setActiveImportJob(job);
  return { started: true as const, state: getImportJobState() };
}

export async function awaitDataImport(rootDir = getDataRootDir(), options: FastImportOptions = {}) {
  const started = await startDataImport(rootDir, options);
  if (!started.started) return { state: started.state, result: (started.state.result as DataImportResult | undefined) ?? null };
  const { getActiveImportJob } = await import('./import-state');
  const job = getActiveImportJob();
  if (!job) return { state: getImportJobState(), result: null };
  const result = await job;
  return { state: getImportJobState(), result };
}
