import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, type ChildProcess, execFileSync } from 'node:child_process';
import type { Database } from './db';
import { getDb, withTransaction } from './db';
import { hashText, splitList, upsertEdgeInDb, upsertEntityInDb } from './normalize';
import { indexPaperChunkInDb, indexPaperDocumentInDb } from './search-index';
import { splitTextIntoParentChildChunks } from './parent-chunk';
import { segmentPaperText } from './paper-segment';
import { isMeaningfulTermName, normalizeTermName } from './kg/term-quality';
import { defaultPaperConcurrency } from './fast-import';
import { getDataRootDir } from './config';
import {
  getConvertWorkDir,
  isPdf2mdAvailable,
  pdf2mdSkipped,
  Pdf2mdServePool
} from './pdf2md';
import {
  isCnPatentSource,
  parseCnPatentText,
  patentKeywords,
  patentPaperKey,
  structurePatentText
} from './patent-text';

type PdfParseResult = { text: string; numpages?: number; info?: Record<string, unknown>; metadata?: unknown };

type PaperDocument = {
  paperKey: string;
  title: string;
  authors: string;
  filePath: string;
  pdfPath: string;
  originalPath: string;
  fileHash: string;
  pageCount: number;
  abstract: string;
  keywords: string;
  references: string[];
  citations: string[];
  algorithms: string[];
  publishYear?: number | null;
  journal?: string | null;
  pubDate?: string | null;
};

type PaperChunk = {
  chunkKey: string;
  paperKey: string;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  section: string;
  text: string;
  tokenEstimate: number;
  parentKey: string | null;
  chunkRole: 'parent' | 'child' | 'reference';
};

const paperExts = new Set(['.pdf', '.caj']);

function readonlySourceData() {
  return process.env.DATA_IMPORT_READONLY === '1';
}

function forceReingest(force?: boolean) {
  return force === true || process.env.FORCE_REINGEST === '1';
}

function isInsideDir(filePath: string, dir: string) {
  const root = path.resolve(dir);
  const resolved = path.resolve(filePath);
  const prefix = `${root.toLowerCase()}${path.sep}`;
  return resolved.toLowerCase() === root.toLowerCase() || resolved.toLowerCase().startsWith(prefix);
}

function isInsideDataRoot(filePath: string) {
  try {
    return isInsideDir(filePath, getDataRootDir());
  } catch {
    return false;
  }
}

async function runInDb(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) await db.prepare(sql).run(...params);
  else await db.prepare(sql).run();
}

function fileHash(filePath: string) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function fileHashFromBuffer(data: Buffer) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

function stripNullBytes(text: string) {
  return String(text || '').replace(/\u0000/g, '');
}

function normalizeWhitespace(text: string) {
  return stripNullBytes(text)
    .replace(/\r/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ /g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function basenameTitle(filePath: string) {
  return path.basename(filePath, path.extname(filePath)).replace(/\s*\(\d+\)$/, '').trim();
}

function mergeKeywordList(existing: string, extra: Array<string | null | undefined>) {
  const parts = `${existing || ''}；${extra.filter(Boolean).join('；')}`
    .split(/[;；,，|/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(parts)].join('；');
}

/** Folder + filename layout used by IEEE 订阅期刊 PDF 包. */
function ieeePathMeta(filePath: string) {
  const posix = filePath.replace(/\\/g, '/');
  const journalMatch = posix.match(/IEEE Transactions on [^/]+/i);
  const journal = journalMatch ? journalMatch[0].trim() : '';
  const base = path.basename(filePath, path.extname(filePath));
  const fileMatch = /^((?:19|20)\d{2})-(\d{2})_(.+)_(\d{5,})$/.exec(base);
  if (!journal && !fileMatch) return null;
  const year = fileMatch ? Number(fileMatch[1]) : null;
  const month = fileMatch ? fileMatch[2] : null;
  const rawTitle = fileMatch
    ? fileMatch[3].replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return {
    journal: journal || null,
    publishYear: year && year >= 1900 && year <= 2100 ? year : null,
    pubDate: year && month ? `${year}-${month}` : null,
    title: rawTitle.slice(0, 200) || null
  };
}

function extractBetween(text: string, starts: RegExp[], ends: RegExp[]) {
  for (const start of starts) {
    const match = start.exec(text);
    if (!match) continue;
    const startIndex = match.index + match[0].length;
    let endIndex = Math.min(text.length, startIndex + 2500);
    const tail = text.slice(startIndex, endIndex);
    for (const end of ends) {
      const endMatch = end.exec(tail);
      if (endMatch && endMatch.index > 20) endIndex = startIndex + endMatch.index;
    }
    return normalizeWhitespace(text.slice(startIndex, endIndex)).slice(0, 2000);
  }
  return '';
}

function inferTitle(text: string, filePath: string, info?: Record<string, unknown>) {
  const ieeeTitle = ieeePathMeta(filePath)?.title || '';
  const filenameTitle = ieeeTitle || basenameTitle(filePath);
  const infoTitle = typeof info?.Title === 'string' ? info.Title.trim() : '';
  const badTitle = /^(Microsoft Word|第\s*\d+\s*卷|电\s*网\s*技\s*术|Vol\.|No\.)/i;
  if (filenameTitle.length >= 6) return filenameTitle.slice(0, 200);
  if (infoTitle && !badTitle.test(infoTitle)) return infoTitle.slice(0, 200);
  const lines = text.split('\n').map((line) => normalizeWhitespace(line)).filter((line) => line.length >= 6 && line.length <= 120);
  const candidate = lines.find((line) => !badTitle.test(line) && !/^(摘要|关键词|Abstract|Key words|第\d+|DOI|中图分类号)/i.test(line));
  return (candidate || filenameTitle).slice(0, 200);
}

function inferAuthors(text: string, title: string) {
  const lines = text.split('\n').map((line) => normalizeWhitespace(line)).filter(Boolean);
  const titleIndex = lines.findIndex((line) => line.includes(title.slice(0, Math.min(20, title.length))));
  const window = lines.slice(Math.max(0, titleIndex + 1), titleIndex >= 0 ? titleIndex + 8 : 8);
  const authorLine = window.find((line) => {
    if (/(摘要|关键词|Abstract|Key words|单位|大学|公司|研究院|DOI)/i.test(line)) return false;
    return /^([一-龥]{2,4}[，,、\s]*){1,12}$/.test(line) || /^[A-Z][A-Za-z .-]+(,\s*[A-Z][A-Za-z .-]+){0,12}$/.test(line);
  });
  return authorLine || '';
}

function extractKeywords(text: string) {
  const match = /(关键词|Key\s*words?)[:：]\s*([^\n]{2,300})/i.exec(text);
  return match ? normalizeWhitespace(match[2]).replace(/[；;]/g, '；').slice(0, 300) : '';
}

function extractReferences(text: string) {
  return segmentPaperText(text).referenceEntries;
}

function extractCitations(text: string) {
  const citations = new Set<string>();
  for (const match of text.matchAll(/\[(\d+(?:[-,，]\d+)*)\]/g)) citations.add(match[0]);
  for (const match of text.matchAll(/([一-龥]{2,4})等(?:人)?\s*\(?\d{4}\)?/g)) citations.add(match[0]);
  for (const match of text.matchAll(/[A-Z][A-Za-z-]+\s+et\s+al\.?,?\s*\(?\d{4}\)?/g)) citations.add(match[0]);
  return [...citations].slice(0, 200);
}

function extractAlgorithms(text: string) {
  const names = new Set<string>();
  const patterns = [
    /([一-龥A-Za-z0-9-]{4,28}(?:算法|方法|模型|策略|控制|优化|调度|预测|辨识|评估|检测|计算|聚类|分类|回归|网络|机制))/g,
    /\b(ADMM|NSGA-?II|DANN|GAN|RTSGAN|LSTM|BiLSTM|GRU|CNN|GNN|GCN|Transformer|MPC|SVM|PPO|DDPG|DQN|K-means|XGBoost|Gaussian Process|GPR)\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = normalizeTermName(normalizeWhitespace(match[1] || match[0]));
      if (isMeaningfulTermName(value, 'algorithm')) names.add(value);
    }
  }
  return [...names].slice(0, 80);
}

function splitReferenceChunks(entries: string[], paperKey: string) {
  return entries.map((entry, index) => ({
    chunkKey: `paper-ref:${hashText(`${paperKey}|${index}|${entry.slice(0, 80)}`).slice(0, 24)}`,
    paperKey,
    chunkIndex: 90_000 + index,
    pageStart: null,
    pageEnd: null,
    section: '参考文献',
    text: entry,
    tokenEstimate: Math.ceil(entry.length / 2),
    parentKey: null,
    chunkRole: 'reference' as const
  }));
}

function splitChunks(text: string, paperKey: string) {
  const { bodyText, referenceEntries } = segmentPaperText(text);
  const source = bodyText.length >= 80 ? bodyText : text;
  const { parents, children } = splitTextIntoParentChildChunks(source, paperKey);
  const references = splitReferenceChunks(referenceEntries, paperKey);
  return [...parents, ...children, ...references];
}

async function parsePdfWithPdfParse(pdfPath: string): Promise<PdfParseResult & { hash: string }> {
  const data = fs.readFileSync(pdfPath);
  const hash = fileHashFromBuffer(data);
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data });
  try {
    const textResult = await parser.getText();
    const infoResult = await parser.getInfo().catch(() => null);
    return {
      text: textResult.text || '',
      numpages: Number((textResult as any).total || (infoResult as any)?.total || 0),
      info: ((infoResult as any)?.info || {}) as Record<string, unknown>,
      metadata: (infoResult as any)?.metadata,
      hash
    };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

let sharedPdf2mdPool: Pdf2mdServePool | null = null;

function getSharedPdf2mdPool() {
  if (!sharedPdf2mdPool) {
    const size = Math.max(1, Math.min(4, Number(process.env.PAPER_INGEST_CONCURRENCY || 2) || 2));
    sharedPdf2mdPool = new Pdf2mdServePool(size);
  }
  return sharedPdf2mdPool;
}

async function parsePdf(pdfPath: string): Promise<PdfParseResult & { hash: string }> {
  const hash = fileHash(pdfPath);
  if (!pdf2mdSkipped() && isPdf2mdAvailable()) {
    try {
      const robust = await getSharedPdf2mdPool().parse(pdfPath, { force: process.env.FORCE_PDF2MD === '1' });
      return {
        text: robust.text || '',
        numpages: robust.numpages,
        info: robust.info,
        hash
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`pdf2md 失败，尝试 pdf-parse：${pdfPath}：${message}`);
      const fallback = await parsePdfWithPdfParse(pdfPath);
      const compact = (fallback.text || '').replace(/\s+/g, '').replace(/--\d+of\d+--/g, '');
      if (compact.length >= 80) return fallback;
      throw new Error(`pdf2md 失败且文本层过短（疑似扫描件，拒绝空语料回退）：${pdfPath}：${message}`);
    }
  }
  return parsePdfWithPdfParse(pdfPath);
}

type WorkerParseResult = {
  text: string;
  numpages: number;
  info: Record<string, unknown>;
  hash: string;
};

class PdfParsePool {
  private workers: ChildProcess[] = [];
  private idle: ChildProcess[] = [];
  private waiters: Array<(worker: ChildProcess) => void> = [];
  private pending = new Map<number, { resolve: (v: WorkerParseResult) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private closed = false;
  private pdf2md: Pdf2mdServePool | null = null;

  constructor(size: number) {
    if (!pdf2mdSkipped() && isPdf2mdAvailable()) {
      this.pdf2md = new Pdf2mdServePool(size);
      return;
    }
    const workerPath = path.resolve(process.cwd(), 'scripts', 'parse-pdf-worker.cjs');
    const n = Math.max(1, size);
    for (let i = 0; i < n; i += 1) {
      const worker = fork(workerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: process.env
      });
      worker.on('message', (msg: { id: number; ok: boolean; text?: string; numpages?: number; info?: Record<string, unknown>; hash?: string; error?: string }) => {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        this.release(worker);
        if (!msg.ok) {
          waiter.reject(new Error(msg.error || 'PDF worker parse failed'));
          return;
        }
        waiter.resolve({
          text: msg.text || '',
          numpages: Number(msg.numpages || 0),
          info: (msg.info || {}) as Record<string, unknown>,
          hash: msg.hash || ''
        });
      });
      worker.on('exit', (code) => {
        if (this.closed) return;
        for (const [id, waiter] of [...this.pending.entries()]) {
          waiter.reject(new Error(`PDF parse worker exited (${code})`));
          this.pending.delete(id);
        }
      });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  private acquire(): Promise<ChildProcess> {
    const free = this.idle.pop();
    if (free) return Promise.resolve(free);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(worker: ChildProcess) {
    const next = this.waiters.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }

  async parse(pdfPath: string): Promise<WorkerParseResult> {
    if (this.closed) throw new Error('PDF parse pool closed');
    const hash = fileHash(pdfPath);
    if (this.pdf2md) {
      try {
        const robust = await this.pdf2md.parse(pdfPath, { force: process.env.FORCE_PDF2MD === '1' });
        return {
          text: robust.text || '',
          numpages: robust.numpages,
          info: robust.info,
          hash
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`pdf2md 池解析失败，尝试 pdf-parse：${pdfPath}：${message}`);
        const fallback = await parsePdfWithPdfParse(pdfPath);
        const compact = (fallback.text || '').replace(/\s+/g, '').replace(/--\d+of\d+--/g, '');
        if (compact.length >= 80) {
          return {
            text: fallback.text || '',
            numpages: Number(fallback.numpages || 0),
            info: (fallback.info || {}) as Record<string, unknown>,
            hash: fallback.hash || hash
          };
        }
        throw new Error(`pdf2md 失败且文本层过短（疑似扫描件，拒绝空语料回退）：${pdfPath}：${message}`);
      }
    }
    const worker = await this.acquire();
    const id = this.nextId++;
    return new Promise<WorkerParseResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.send({ id, pdfPath });
    });
  }

  async close() {
    this.closed = true;
    if (this.pdf2md) {
      await this.pdf2md.close();
      this.pdf2md = null;
      return;
    }
    await Promise.all(
      this.workers.map(
        (worker) =>
          new Promise<void>((resolve) => {
            worker.once('exit', () => resolve());
            worker.kill();
            setTimeout(() => resolve(), 2000);
          })
      )
    );
    this.workers = [];
    this.idle = [];
  }
}

function knownConverterCommands() {
  const configured = process.env.CAJ_CONVERTER ? [process.env.CAJ_CONVERTER] : [];
  const bundledCmd = path.join(process.cwd(), 'tools', 'caj2pdf.cmd');
  const bundledSh = path.join(process.cwd(), 'tools', 'caj2pdf.sh');
  return [...configured, bundledCmd, bundledSh, 'caj2pdf', 'caj2pdf.exe', 'caj2pdf-qt', 'caj2pdf-qt.exe'];
}

function tryConvertWithCommand(command: string, cajPath: string, outputPath: string) {
  const argSets = [
    ['convert', cajPath, '-o', outputPath],
    [cajPath, '-o', outputPath],
    ['convert', cajPath, outputPath],
    [cajPath, outputPath]
  ];
  for (const args of argSets) {
    try {
      execFileSync(command, args, { stdio: 'ignore', timeout: 120000, shell: process.platform === 'win32' && /\.cmd$/i.test(command) });
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return true;
    } catch {
      // try next shape
    }
  }
  return false;
}

export function convertCajToPdf(cajPath: string, options: { deleteSource?: boolean } = {}) {
  const deleteSource =
    (options.deleteSource ?? false) && !readonlySourceData() && !isInsideDataRoot(cajPath);
  const baseName = `${path.basename(cajPath, path.extname(cajPath))}.pdf`;
  const siblingPdf = path.join(path.dirname(cajPath), baseName);
  // 扁平目录：caj/foo.caj → 已转换到 pdf/foo.pdf
  const pdfDirSibling = path.join(path.dirname(path.dirname(cajPath)), 'pdf', baseName);
  const workPdf = path.join(
    getConvertWorkDir(),
    'caj-pdf',
    `${safeName(path.basename(cajPath, path.extname(cajPath)))}_${crypto
      .createHash('sha1')
      .update(path.resolve(cajPath))
      .digest('hex')
      .slice(0, 12)}.pdf`
  );
  const existingCandidates = [siblingPdf, pdfDirSibling, workPdf].filter(
    (p) => fs.existsSync(p) && fs.statSync(p).size > 0
  );
  if (existingCandidates.length) {
    const pdfPath = existingCandidates[0];
    if (deleteSource && fs.existsSync(cajPath)) {
      fs.unlinkSync(cajPath);
      return { pdfPath, converted: false, method: 'existing-sibling-pdf', deletedCaj: true };
    }
    return { pdfPath, converted: false, method: 'existing-sibling-pdf', deletedCaj: false };
  }

  const outputPath = workPdf;
  ensureDir(path.dirname(outputPath));

  for (const command of knownConverterCommands()) {
    if (tryConvertWithCommand(command, cajPath, outputPath)) {
      if (deleteSource && fs.existsSync(cajPath)) fs.unlinkSync(cajPath);
      return { pdfPath: outputPath, converted: true, method: command, deletedCaj: deleteSource };
    }
  }

  throw new Error(`无法转换 CAJ：${cajPath}。请安装 caj2pdf 或设置 CAJ_CONVERTER；同名 PDF 已存在时会自动复用，新转换写入 storage/convert-work/caj-pdf。`);
}

export function listPaperFiles(dir: string) {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (paperExts.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

export function listCajFiles(dir: string) {
  return listPaperFiles(dir).filter((file) => path.extname(file).toLowerCase() === '.caj');
}

export function convertCajFilesInDirectory(
  dir: string,
  options: { onProgress?: (current: number, total: number, filePath: string) => void; deleteSource?: boolean } = {}
) {
  const files = listCajFiles(dir);
  const deleteSource = options.deleteSource ?? false;
  const results: Array<{ filePath: string; pdfPath?: string; converted: boolean; deletedCaj?: boolean; error?: string }> = [];
  files.forEach((file, index) => {
    options.onProgress?.(index + 1, files.length, file);
    try {
      const converted = convertCajToPdf(file, { deleteSource });
      results.push({ filePath: file, pdfPath: converted.pdfPath, converted: converted.converted, deletedCaj: converted.deletedCaj });
    } catch (error) {
      results.push({ filePath: file, converted: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { dir, total: files.length, converted: results.filter((item) => item.converted).length, deleted: results.filter((item) => item.deletedCaj).length, failed: results.filter((item) => item.error).length, results: results.slice(0, 30) };
}

function titleCore(title: string) {
  return title.replace(/[_＿][^_＿]+$/, '').replace(/[\s《》“”"'：:，,。；;（）()\-—]/g, '').slice(0, 40);
}

async function linkCrossCitationsInDb(db: Database, doc: PaperDocument) {
  if (!doc.references.length) return;
  const papers = await db.prepare('SELECT paper_key, title FROM paper_documents WHERE paper_key <> ?').all<{ paper_key: string; title: string }>(doc.paperKey);
  const referenceText = doc.references.join('\n');
  for (const paper of papers) {
    const core = titleCore(paper.title);
    if (core.length >= 8 && referenceText.replace(/\s/g, '').includes(core)) {
      await upsertEdgeInDb(db, doc.paperKey, paper.paper_key, 'cites_paper', 9, { matchedTitle: paper.title });
    }
  }
}

async function upsertPaperGraph(db: Database, doc: PaperDocument) {
  const paperEntity = await upsertEntityInDb(db, 'paper', doc.title, { paperKey: doc.paperKey, filePath: doc.filePath });
  await upsertEdgeInDb(db, doc.paperKey, paperEntity, 'entity', 8);
  for (const author of splitList(doc.authors)) await upsertEdgeInDb(db, doc.paperKey, await upsertEntityInDb(db, 'person', author), 'authored_by', 5);
  for (const keyword of splitList(doc.keywords)) await upsertEdgeInDb(db, doc.paperKey, await upsertEntityInDb(db, 'keyword', keyword), 'has_keyword', 4);
  for (const algorithm of doc.algorithms) await upsertEdgeInDb(db, doc.paperKey, await upsertEntityInDb(db, 'algorithm', algorithm), 'mentions_algorithm', 6);
  for (const [index, reference] of doc.references.entries()) {
    const target = await upsertEntityInDb(db, 'reference', reference.slice(0, 180), { order: index + 1 });
    await upsertEdgeInDb(db, doc.paperKey, target, 'cites', 2, { reference });
  }
}

async function upsertPaperInDb(db: Database, doc: PaperDocument, chunks: PaperChunk[]) {
  await runInDb(db, 'DELETE FROM search_records WHERE source_type = ? AND source_key IN (SELECT chunk_key FROM paper_chunks WHERE paper_key IN (SELECT paper_key FROM paper_documents WHERE file_hash = ? AND paper_key <> ?))', ['paper_chunk', doc.fileHash, doc.paperKey]);
  await runInDb(db, 'DELETE FROM search_records WHERE source_type = ? AND source_key IN (SELECT paper_key FROM paper_documents WHERE file_hash = ? AND paper_key <> ?)', ['paper', doc.fileHash, doc.paperKey]);
  await runInDb(db, 'DELETE FROM paper_chunks WHERE paper_key IN (SELECT paper_key FROM paper_documents WHERE file_hash = ? AND paper_key <> ?)', [doc.fileHash, doc.paperKey]);
  await runInDb(db, 'DELETE FROM paper_documents WHERE file_hash = ? AND paper_key <> ?', [doc.fileHash, doc.paperKey]);

  await runInDb(
    db,
    `INSERT INTO paper_documents(
      paper_key, title, authors, file_path, pdf_path, original_path, file_hash, page_count, abstract, keywords,
      references_json, citations_json, algorithms_json, publish_year, journal, pub_date, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(paper_key) DO UPDATE SET
      title=excluded.title,
      authors=excluded.authors,
      file_path=excluded.file_path,
      pdf_path=excluded.pdf_path,
      original_path=excluded.original_path,
      file_hash=excluded.file_hash,
      page_count=excluded.page_count,
      abstract=excluded.abstract,
      keywords=excluded.keywords,
      references_json=excluded.references_json,
      citations_json=excluded.citations_json,
      algorithms_json=excluded.algorithms_json,
      publish_year=COALESCE(excluded.publish_year, paper_documents.publish_year),
      journal=COALESCE(excluded.journal, paper_documents.journal),
      pub_date=COALESCE(excluded.pub_date, paper_documents.pub_date),
      updated_at=CURRENT_TIMESTAMP`,
    [
      doc.paperKey,
      doc.title,
      doc.authors,
      doc.filePath,
      doc.pdfPath,
      doc.originalPath,
      doc.fileHash,
      doc.pageCount,
      doc.abstract,
      doc.keywords,
      JSON.stringify(doc.references),
      JSON.stringify(doc.citations),
      JSON.stringify(doc.algorithms),
      doc.publishYear ?? null,
      doc.journal ?? null,
      doc.pubDate ?? null
    ]
  );

  await runInDb(db, 'DELETE FROM search_records WHERE source_type = ? AND source_key IN (SELECT chunk_key FROM paper_chunks WHERE paper_key = ?)', ['paper_chunk', doc.paperKey]);
  await runInDb(db, 'DELETE FROM search_records WHERE source_type = ? AND source_key = ?', ['paper', doc.paperKey]);
  await runInDb(db, 'DELETE FROM paper_chunks WHERE paper_key = ?', [doc.paperKey]);
  if (chunks.length) {
    const chunkKeys = [...new Set(chunks.map((chunk) => chunk.chunkKey))];
    // 清理可能残留在其它 paper_key 下的同名 chunk，避免 UNIQUE 冲突
    for (let i = 0; i < chunkKeys.length; i += 200) {
      const slice = chunkKeys.slice(i, i + 200);
      await runInDb(db, `DELETE FROM paper_chunks WHERE chunk_key IN (${slice.map(() => '?').join(',')})`, slice);
    }
  }
  const indexedPaper = {
    paper_key: doc.paperKey,
    title: doc.title,
    authors: doc.authors,
    file_path: doc.filePath,
    pdf_path: doc.pdfPath,
    original_path: doc.originalPath,
    page_count: doc.pageCount,
    abstract: doc.abstract,
    keywords: doc.keywords,
    references_json: JSON.stringify(doc.references),
    citations_json: JSON.stringify(doc.citations),
    algorithms_json: JSON.stringify(doc.algorithms)
  };
  const insertedChunkKeys = new Set<string>();
  for (const chunk of chunks) {
    if (insertedChunkKeys.has(chunk.chunkKey)) continue;
    insertedChunkKeys.add(chunk.chunkKey);
    const indexedChunk = {
      chunk_key: chunk.chunkKey,
      paper_key: chunk.paperKey,
      chunk_index: chunk.chunkIndex,
      page_start: chunk.pageStart,
      page_end: chunk.pageEnd,
      section: chunk.section,
      text: chunk.text,
      token_estimate: chunk.tokenEstimate,
      parent_key: chunk.parentKey,
      chunk_role: chunk.chunkRole
    };
    await runInDb(
      db,
      `INSERT OR REPLACE INTO paper_chunks(
        chunk_key, paper_key, chunk_index, page_start, page_end, section, text, token_estimate, parent_key, chunk_role, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        chunk.chunkKey,
        chunk.paperKey,
        chunk.chunkIndex,
        chunk.pageStart,
        chunk.pageEnd,
        chunk.section,
        stripNullBytes(chunk.text),
        chunk.tokenEstimate,
        chunk.parentKey,
        chunk.chunkRole
      ]
    );
    if (process.env.SKIP_INLINE_INDEX !== '1' && chunk.chunkRole === 'child') {
      await indexPaperChunkInDb(db, indexedPaper, indexedChunk);
    }
    // reference / parent 块只存库，不进 search_records 检索索引
  }
  if (process.env.SKIP_INLINE_INDEX !== '1') {
    await indexPaperDocumentInDb(db, indexedPaper);
  }
  if (process.env.SKIP_PAPER_GRAPH !== '1') {
    await upsertPaperGraph(db, doc);
  }
  if (process.env.SKIP_INLINE_INDEX !== '1') {
    await linkCrossCitationsInDb(db, doc);
  }
}

async function trySkipExistingPaper(filePath: string, pdfPath: string, force?: boolean) {
  if (forceReingest(force) || process.env.SKIP_EXISTING_PAPERS !== '1') return null;
  const byPath = await getDb()
    .prepare('SELECT paper_key, pdf_path FROM paper_documents WHERE pdf_path = ? OR file_path = ? OR original_path = ?')
    .get<{ paper_key: string; pdf_path: string }>(pdfPath, pdfPath, filePath);
  if (byPath) {
    return {
      paperKey: byPath.paper_key,
      title: '',
      pdfPath,
      originalPath: filePath,
      converted: false,
      convertMethod: 'skip-existing-path',
      pageCount: 0,
      chunks: 0,
      parentChunks: 0,
      referenceChunks: 0,
      references: 0,
      citations: 0,
      algorithms: 0,
      skipped: true as const
    };
  }
  return null;
}

async function trySkipExistingByHash(filePath: string, pdfPath: string, hash: string, force?: boolean) {
  if (forceReingest(force) || process.env.SKIP_EXISTING_PAPERS !== '1') return null;
  const existing = await getDb().prepare('SELECT paper_key, pdf_path FROM paper_documents WHERE file_hash = ?').get<{
    paper_key: string;
    pdf_path: string;
  }>(hash);
  if (!existing) return null;
  if (existing.pdf_path !== pdfPath) {
    await getDb()
      .prepare('UPDATE paper_documents SET file_path=?, pdf_path=?, original_path=?, updated_at=CURRENT_TIMESTAMP WHERE paper_key=?')
      .run(filePath, pdfPath, filePath, existing.paper_key);
  }
  return {
    paperKey: existing.paper_key,
    title: '',
    pdfPath,
    originalPath: filePath,
    converted: false,
    convertMethod: 'skip-existing',
    pageCount: 0,
    chunks: 0,
    parentChunks: 0,
    referenceChunks: 0,
    references: 0,
    citations: 0,
    algorithms: 0,
    skipped: true as const
  };
}

function yearFromDate(value: string) {
  const match = String(value || '').match(/((?:19|20)\d{2})/);
  return match ? Number(match[1]) : null;
}

function buildPaperFromParsed(
  filePath: string,
  pdfPath: string,
  parsed: { text: string; numpages?: number; info?: Record<string, unknown>; hash: string },
  options: { keyPrefix?: string } = {}
) {
  const text = normalizeWhitespace(parsed.text || '');
  if (text.length < 80) throw new Error(`PDF 文本抽取结果过短，可能是扫描件或加密文件：${pdfPath}`);

  const prefix = (options.keyPrefix || 'paper:').endsWith(':')
    ? (options.keyPrefix || 'paper:')
    : `${options.keyPrefix || 'paper'}:`;
  const hash = parsed.hash;
  const treatAsPatent = prefix.startsWith('patent:') || isCnPatentSource(filePath, text);

  if (treatAsPatent) {
    const meta = parseCnPatentText(parsed.text || text, filePath);
    const title = meta.title || inferTitle(text, filePath, parsed.info);
    const authors = meta.applicant || meta.inventors || inferAuthors(text, title);
    const abstract = meta.abstract || extractBetween(text, [/摘要\s*[:：]?/g, /Abstract\s*[:：]?/gi], [/关键词/g, /Key\s*words?/gi, /权利要求/g, /1\s+/g]);
    const paperKey = prefix.startsWith('patent:') ? patentPaperKey(meta, hash) : `${prefix}${hash.slice(0, 24)}`;
    const structured = structurePatentText(parsed.text || text, { ...meta, title, applicant: authors, abstract });
    const chunks = splitChunks(structured, paperKey);
    const doc: PaperDocument = {
      paperKey,
      title,
      authors,
      filePath,
      pdfPath,
      originalPath: filePath,
      fileHash: hash,
      pageCount: Number(parsed.numpages || 0),
      abstract,
      keywords: patentKeywords({ ...meta, title }),
      references: [],
      citations: meta.pubNo ? [meta.pubNo] : [],
      algorithms: extractAlgorithms(text),
      publishYear: yearFromDate(meta.pubDate || meta.appDate),
      journal: meta.patentType,
      pubDate: meta.pubDate || meta.appDate || null
    };
    return { doc, chunks };
  }

  const ieee = ieeePathMeta(filePath);
  const title = inferTitle(text, filePath, parsed.info);
  const authors = inferAuthors(text, title);
  const abstract = extractBetween(text, [/摘要\s*[:：]?/g, /Abstract\s*[:：]?/gi], [/关键词/g, /Key\s*words?/gi, /引言/g, /1\s+/g]);
  const keywords = mergeKeywordList(extractKeywords(text), [ieee?.journal, ieee?.journal ? 'IEEE订阅期刊' : '']);
  const references = extractReferences(text);
  const citations = extractCitations(text);
  const algorithms = extractAlgorithms(text);
  const paperKey = `${prefix}${hash.slice(0, 24)}`;
  const chunks = splitChunks(text, paperKey);
  const doc: PaperDocument = {
    paperKey,
    title,
    authors,
    filePath,
    pdfPath,
    originalPath: filePath,
    fileHash: hash,
    pageCount: Number(parsed.numpages || 0),
    abstract,
    keywords,
    references,
    citations,
    algorithms,
    publishYear: ieee?.publishYear ?? null,
    journal: ieee?.journal ?? null,
    pubDate: ieee?.pubDate ?? null
  };
  return { doc, chunks };
}

function paperIngestResult(
  doc: PaperDocument,
  chunks: PaperChunk[],
  meta: { converted: boolean; convertMethod: string }
) {
  return {
    paperKey: doc.paperKey,
    title: doc.title,
    pdfPath: doc.pdfPath,
    originalPath: doc.originalPath,
    converted: meta.converted,
    convertMethod: meta.convertMethod,
    pageCount: doc.pageCount,
    chunks: chunks.filter((chunk) => chunk.chunkRole === 'child').length,
    parentChunks: chunks.filter((chunk) => chunk.chunkRole === 'parent').length,
    referenceChunks: chunks.filter((chunk) => chunk.chunkRole === 'reference').length,
    references: doc.references.length,
    citations: doc.citations.length,
    algorithms: doc.algorithms.length,
    skipped: false as const
  };
}

export async function ingestPaperFile(
  filePath: string,
  options: { keyPrefix?: string; force?: boolean; originalPath?: string } = {}
) {
  const sourcePath = options.originalPath || filePath;
  const ext = path.extname(filePath).toLowerCase();
  const converted = ext === '.caj'
    ? convertCajToPdf(filePath, { deleteSource: false })
    : { pdfPath: filePath, converted: false, method: 'pdf' };

  const skippedPath = await trySkipExistingPaper(sourcePath, converted.pdfPath, options.force);
  if (skippedPath) return skippedPath;

  const parsed = await parsePdf(converted.pdfPath);
  const hash = parsed.hash || fileHash(converted.pdfPath);
  const skippedHash = await trySkipExistingByHash(sourcePath, converted.pdfPath, hash, options.force);
  if (skippedHash) return skippedHash;

  const { doc, chunks } = buildPaperFromParsed(sourcePath, converted.pdfPath, { ...parsed, hash }, options);
  await withTransaction(async (db) => await upsertPaperInDb(db, doc, chunks), true);
  return paperIngestResult(doc, chunks, { converted: converted.converted, convertMethod: converted.method });
}

export async function ingestPaperDirectory(
  dir: string,
  options: { keyPrefix?: string; force?: boolean } = {}
) {
  const skipExisting = process.env.SKIP_EXISTING_PAPERS === '1' && !forceReingest(options.force);
  const skipCaj = process.env.SKIP_CAJ_CONVERT === '1';
  const files = listPaperFiles(dir).filter((file) => {
    if (!skipCaj) return true;
    return path.extname(file).toLowerCase() !== '.caj';
  });
  const results: Array<Awaited<ReturnType<typeof ingestPaperFile>>> = [];
  const errors: Array<{ filePath: string; error: string }> = [];
  const changedKeys: string[] = [];
  const seenPdf = new Set<string>();
  const onProgress = (global as typeof globalThis & {
    __paperIngestProgress?: (current: number, total: number, filePath: string) => void;
  }).__paperIngestProgress;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.pdf') seenPdf.add(path.resolve(file).toLowerCase());
  }

  const queue = files.filter((file) => {
    const ext = path.extname(file).toLowerCase();
    const siblingPdf = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.pdf`);
    if (ext === '.caj' && seenPdf.has(path.resolve(siblingPdf).toLowerCase())) return false;
    return true;
  });

  const concurrency = defaultPaperConcurrency();
  const batchSize = Math.max(1, Number(process.env.PAPER_INGEST_BATCH || 20) || 20);

  // 预加载已入库路径/hash，避免逐文件查询 + 重复读盘
  const existingPathSet = new Set<string>();
  const existingHashSet = new Set<string>();
  if (skipExisting) {
    const rows = await getDb()
      .prepare(
        `SELECT file_hash, pdf_path, file_path, original_path FROM paper_documents`
      )
      .all<{ file_hash: string; pdf_path: string; file_path: string; original_path: string }>();
    for (const row of rows) {
      if (row.file_hash) existingHashSet.add(row.file_hash);
      for (const p of [row.pdf_path, row.file_path, row.original_path]) {
        if (p) existingPathSet.add(path.resolve(p).toLowerCase());
      }
    }
  }

  const pool = new PdfParsePool(concurrency);
  type PendingWrite = { doc: PaperDocument; chunks: PaperChunk[]; meta: { converted: boolean; convertMethod: string }; filePath: string };
  const writeQueue: PendingWrite[] = [];
  let writeChain: Promise<void> = Promise.resolve();
  let processed = 0;
  const total = queue.length;

  async function commitBatch(batch: PendingWrite[]) {
    if (!batch.length) return;
    const seen = new Set<string>();
    const deduped: PendingWrite[] = [];
    for (let i = batch.length - 1; i >= 0; i -= 1) {
      const item = batch[i];
      if (seen.has(item.doc.paperKey)) continue;
      seen.add(item.doc.paperKey);
      deduped.push(item);
    }
    deduped.reverse();

    try {
      await withTransaction(async (db) => {
        for (const item of deduped) await upsertPaperInDb(db, item.doc, item.chunks);
      });
      for (const item of deduped) {
        changedKeys.push(item.doc.paperKey);
        results.push(paperIngestResult(item.doc, item.chunks, item.meta));
      }
    } catch (error) {
      for (const item of deduped) {
        try {
          await withTransaction(async (db) => await upsertPaperInDb(db, item.doc, item.chunks));
          changedKeys.push(item.doc.paperKey);
          results.push(paperIngestResult(item.doc, item.chunks, item.meta));
        } catch (inner) {
          errors.push({
            filePath: item.filePath,
            error: inner instanceof Error ? inner.message : String(inner)
          });
        }
      }
    }
  }

  function enqueueWrite(item: PendingWrite) {
    writeChain = writeChain.then(async () => {
      // 同一批并发解析到相同 hash 时避免重复写入；FORCE_REINGEST 必须覆盖已有论文
      if (!forceReingest(options.force)) {
        const exists = await getDb()
          .prepare('SELECT 1 AS ok FROM paper_documents WHERE file_hash = ? OR paper_key = ?')
          .get<{ ok: number }>(item.doc.fileHash, item.doc.paperKey);
        if (exists) {
          results.push({
            paperKey: item.doc.paperKey,
            title: item.doc.title,
            pdfPath: item.doc.pdfPath,
            originalPath: item.doc.originalPath,
            converted: false,
            convertMethod: 'skip-existing-race',
            pageCount: item.doc.pageCount,
            chunks: 0,
            parentChunks: 0,
            referenceChunks: 0,
            references: 0,
            citations: 0,
            algorithms: 0,
            skipped: true as const
          });
          return;
        }
      }
      writeQueue.push(item);
      if (writeQueue.length >= batchSize) {
        await commitBatch(writeQueue.splice(0, writeQueue.length));
      }
    });
    return writeChain;
  }

  async function flushWrites() {
    writeChain = writeChain.then(async () => {
      await commitBatch(writeQueue.splice(0, writeQueue.length));
    });
    await writeChain;
  }

  try {
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= queue.length) return;
        const file = queue[index];
        processed += 1;
        onProgress?.(processed, total, file);
        try {
          const ext = path.extname(file).toLowerCase();
          const converted = ext === '.caj'
            ? convertCajToPdf(file, { deleteSource: false })
            : { pdfPath: file, converted: false, method: 'pdf' };

          const resolvedPdf = path.resolve(converted.pdfPath).toLowerCase();
          if (skipExisting && existingPathSet.has(resolvedPdf)) {
            results.push({
              paperKey: '',
              title: '',
              pdfPath: converted.pdfPath,
              originalPath: file,
              converted: false,
              convertMethod: 'skip-existing-path',
              pageCount: 0,
              chunks: 0,
              parentChunks: 0,
              referenceChunks: 0,
              references: 0,
              citations: 0,
              algorithms: 0,
              skipped: true as const
            });
            continue;
          }

          if (skipExisting) {
            const preHash = fileHash(converted.pdfPath);
            if (existingHashSet.has(preHash)) {
              results.push({
                paperKey: '',
                title: '',
                pdfPath: converted.pdfPath,
                originalPath: file,
                converted: false,
                convertMethod: 'skip-existing',
                pageCount: 0,
                chunks: 0,
                parentChunks: 0,
                referenceChunks: 0,
                references: 0,
                citations: 0,
                algorithms: 0,
                skipped: true as const
              });
              continue;
            }
          }

          const parsed = await pool.parse(converted.pdfPath);
          const { doc, chunks } = buildPaperFromParsed(
            file,
            converted.pdfPath,
            { ...parsed, hash: parsed.hash || fileHash(converted.pdfPath) },
            options
          );
          existingHashSet.add(doc.fileHash);
          existingPathSet.add(path.resolve(doc.pdfPath).toLowerCase());
          await enqueueWrite({
            doc,
            chunks,
            meta: { converted: converted.converted, convertMethod: converted.method },
            filePath: file
          });
        } catch (error) {
          errors.push({ filePath: file, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
    await flushWrites();
  } finally {
    await pool.close();
  }

  const skipped = results.filter((item) => 'skipped' in item && item.skipped).length;
  return {
    dir,
    files: files.length,
    imported: results.length,
    failed: errors.length,
    skipped,
    changedKeys,
    results,
    errors
  };
}
