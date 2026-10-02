import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { trackChildProcess } from '@/lib/runtime-children';

const PDF2MD_CHILD = {
  id: 'pdf2md',
  name: 'PDF Parser',
  kind: 'sidecar' as const,
  caption: 'Converts documents to Markdown',
  jobType: 'data-import'
};

export type Pdf2mdOcrMode = 'auto' | 'always' | 'never';

export type Pdf2mdResult = {
  text: string;
  numpages: number;
  info: Record<string, unknown>;
  extractor: string;
  ocrPages: number[];
  outputPath: string;
  metaPath: string;
  cached: boolean;
};

function repoRoot() {
  return process.cwd();
}

export function getConvertWorkDir() {
  return path.resolve(process.env.CONVERT_WORK_DIR || path.join(repoRoot(), 'storage', 'convert-work'));
}

export function pdf2mdSkipped() {
  return process.env.SKIP_PDF2MD === '1';
}

export function getPdf2mdOcrMode(): Pdf2mdOcrMode {
  const value = String(process.env.PDF2MD_OCR || 'auto').toLowerCase();
  if (value === 'always' || value === 'never' || value === 'auto') return value;
  return 'auto';
}

export function getPdf2mdPython(): string {
  if (process.env.PDF2MD_PYTHON) return process.env.PDF2MD_PYTHON;
  const root = repoRoot();
  const win = path.join(root, 'tools', 'pdf2md-venv', 'Scripts', 'python.exe');
  const nix = path.join(root, 'tools', 'pdf2md-venv', 'bin', 'python');
  if (fs.existsSync(win)) return win;
  if (fs.existsSync(nix)) return nix;
  return 'python';
}

export function getPdf2mdScript(): string {
  return path.join(repoRoot(), 'tools', 'pdf2md', 'pdf_to_md.py');
}

export function isPdf2mdAvailable() {
  if (pdf2mdSkipped()) return false;
  return fs.existsSync(getPdf2mdScript()) && (process.env.PDF2MD_PYTHON || fs.existsSync(getPdf2mdPython()));
}

export function fileSha1(filePath: string) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function timeoutMsForPdf(pdfPath: string) {
  const env = Number(process.env.PDF2MD_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  const sizeMb = Math.max(1, fs.statSync(pdfPath).size / (1024 * 1024));
  return Math.min(120 * 60 * 1000, Math.max(20 * 60 * 1000, Math.ceil(sizeMb * 90_000)));
}

function cachePaths(hash: string) {
  const dir = path.join(getConvertWorkDir(), 'md');
  return {
    dir,
    md: path.join(dir, `${hash}.md`),
    meta: path.join(dir, `${hash}.json`)
  };
}

function readCachedMeta(metaPath: string, mdPath: string): Pdf2mdResult | null {
  if (!fs.existsSync(metaPath) || !fs.existsSync(mdPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as {
      text?: string;
      numpages?: number;
      extractor?: string;
      ocr_pages?: number[];
      title?: string;
    };
    const text = String(meta.text || '').trim();
    if (text.length < 40) return null;
    return {
      text,
      numpages: Number(meta.numpages || 0),
      info: { Title: meta.title || '', extractor: meta.extractor || 'pymupdf' },
      extractor: String(meta.extractor || 'pymupdf'),
      ocrPages: Array.isArray(meta.ocr_pages) ? meta.ocr_pages.map(Number) : [],
      outputPath: mdPath,
      metaPath,
      cached: true
    };
  } catch {
    return null;
  }
}

export async function extractPdfWithPdf2md(
  pdfPath: string,
  options: { force?: boolean; ocr?: Pdf2mdOcrMode } = {}
): Promise<Pdf2mdResult> {
  if (!isPdf2mdAvailable()) throw new Error('pdf2md 不可用：缺少 tools/pdf2md 或 venv');
  const hash = fileSha1(pdfPath);
  const cache = cachePaths(hash);
  const force = options.force === true || process.env.FORCE_PDF2MD === '1';
  if (!force) {
    const cached = readCachedMeta(cache.meta, cache.md);
    if (cached) return cached;
  }
  ensureDir(cache.dir);
  const python = getPdf2mdPython();
  const script = getPdf2mdScript();
  const ocr = options.ocr || getPdf2mdOcrMode();
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(python, [script, '--input', pdfPath, '--output', cache.md, '--meta', cache.meta, '--ocr', ocr], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    trackChildProcess(proc, PDF2MD_CHILD);
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`pdf2md 超时：${pdfPath}`));
    }, timeoutMsForPdf(pdfPath));
    proc.stderr.setEncoding('utf8');
    proc.stdout.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      const text = String(chunk).trim();
      if (text) process.stderr.write(`${text}\n`);
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`pdf2md 退出码 ${code}：${pdfPath}`));
    });
  });
  const cached = readCachedMeta(cache.meta, cache.md);
  if (cached) return { ...cached, cached: false };
  throw new Error(`pdf2md 未写出有效结果：${pdfPath}`);
}

type ServeRequest = {
  id: number;
  resolve: (value: Pdf2mdResult) => void;
  reject: (error: Error) => void;
};

export class Pdf2mdServePool {
  private workers: Pdf2mdServeWorker[] = [];
  private cursor = 0;

  constructor(size: number) {
    const n = Math.max(1, size);
    for (let i = 0; i < n; i += 1) this.workers.push(new Pdf2mdServeWorker());
  }

  async parse(pdfPath: string, options: { force?: boolean; ocr?: Pdf2mdOcrMode } = {}) {
    const hash = fileSha1(pdfPath);
    const cache = cachePaths(hash);
    const force = options.force === true || process.env.FORCE_PDF2MD === '1';
    if (!force) {
      const cached = readCachedMeta(cache.meta, cache.md);
      if (cached) return cached;
    }
    ensureDir(cache.dir);
    const worker = this.workers[this.cursor % this.workers.length];
    this.cursor += 1;
    return worker.parse(pdfPath, cache.md, cache.meta, options.ocr || getPdf2mdOcrMode(), timeoutMsForPdf(pdfPath));
  }

  async close() {
    await Promise.all(this.workers.map((worker) => worker.close()));
    this.workers = [];
  }
}

class Pdf2mdServeWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, ServeRequest>();
  private closed = false;

  private start() {
    if (this.proc || this.closed) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const proc = spawn(getPdf2mdPython(), [getPdf2mdScript(), '--serve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      this.proc = proc;
      trackChildProcess(proc, PDF2MD_CHILD);
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        this.buf += chunk;
        let idx = this.buf.indexOf('\n');
        while (idx >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (line) this.handleLine(line);
          idx = this.buf.indexOf('\n');
        }
      });
      let ready = false;
      const markReady = () => {
        if (ready) return;
        ready = true;
        resolve();
      };
      proc.stderr.on('data', (chunk: string) => {
        const text = String(chunk);
        if (text.includes('serve mode ready')) markReady();
        const trimmed = text.trim();
        if (trimmed) process.stderr.write(`[pdf2md] ${trimmed}\n`);
      });
      proc.on('error', (error) => {
        this.failAll(error);
        reject(error);
      });
      proc.on('exit', (code) => {
        this.proc = null;
        this.failAll(new Error(`pdf2md serve exited (${code})`));
        if (!ready) reject(new Error(`pdf2md serve exited (${code})`));
      });
      setTimeout(markReady, 8000);
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private handleLine(line: string) {
    let msg: { id?: number; ok?: boolean; error?: string; meta?: string; output?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const id = Number(msg.id);
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (!msg.ok) {
      waiter.reject(new Error(msg.error || 'pdf2md serve failed'));
      return;
    }
    const cached = readCachedMeta(String(msg.meta || ''), String(msg.output || ''));
    if (!cached) {
      waiter.reject(new Error('pdf2md serve 未写出 meta'));
      return;
    }
    waiter.resolve({ ...cached, cached: false });
  }

  private failAll(error: Error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  async parse(pdfPath: string, outputPath: string, metaPath: string, ocr: Pdf2mdOcrMode, timeout: number) {
    await this.start();
    if (!this.proc) throw new Error('pdf2md serve 未启动');
    const id = this.nextId++;
    return new Promise<Pdf2mdResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pdf2md 超时：${pdfPath}`));
      }, timeout);
      this.pending.set(id, {
        id,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.proc!.stdin.write(
        `${JSON.stringify({ id, input: pdfPath, output: outputPath, meta: metaPath, ocr })}\n`
      );
    });
  }

  async close() {
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`);
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 2000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
