import fs from 'node:fs';
import path from 'node:path';
import { getCorpusRoot } from './schema';

export const CORPUS_BROWSE_DOMAINS = [
  'papers',
  'patents',
  'books',
  'projects',
  'national-projects',
  'people'
] as const;

export type CorpusBrowseDomain = (typeof CORPUS_BROWSE_DOMAINS)[number];

export type CorpusBrowseFile = {
  name: string;
  relativePath: string;
  title: string;
  size: number;
  mtime: string;
};

type DomainCache = {
  dirMtimeMs: number;
  names: string[];
};

const domainCaches = new Map<CorpusBrowseDomain, DomainCache>();

const MD_RE = /\.md$/i;
const MAX_PREVIEW_BYTES = 1_500_000;

export function isCorpusBrowseDomain(value: string): value is CorpusBrowseDomain {
  return (CORPUS_BROWSE_DOMAINS as readonly string[]).includes(value);
}

function toPosix(value: string) {
  return value.replace(/\\/g, '/');
}

function isUnder(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function domainDir(domain: CorpusBrowseDomain) {
  return path.join(getCorpusRoot(), domain);
}

function readDirMtimeMs(dir: string) {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

function listDomainNames(domain: CorpusBrowseDomain): string[] {
  const dir = domainDir(domain);
  if (!fs.existsSync(dir)) return [];

  const dirMtimeMs = readDirMtimeMs(dir);
  const cached = domainCaches.get(domain);
  if (cached && cached.dirMtimeMs === dirMtimeMs) return cached.names;

  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MD_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  domainCaches.set(domain, { dirMtimeMs, names });
  return names;
}

function extractTitle(raw: string, fallback: string) {
  if (!raw.startsWith('---')) return fallback;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return fallback;
  const frontmatter = raw.slice(3, end);
  const match = frontmatter.match(/^\s*title:\s*(.+)\s*$/m);
  if (!match) return fallback;
  let title = match[1].trim();
  if (
    (title.startsWith('"') && title.endsWith('"'))
    || (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1);
  }
  return title || fallback;
}

function peekTitle(filePath: string, fallback: string) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return extractTitle(buffer.slice(0, bytesRead).toString('utf8'), fallback);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return fallback;
  }
}

export function listCorpusBrowseFiles(
  domain: CorpusBrowseDomain,
  page: number,
  pageSize: number
): { rows: CorpusBrowseFile[]; total: number; page: number; pageSize: number } {
  const names = listDomainNames(domain);
  const total = names.length;
  const safePage = Math.max(1, page);
  const safePageSize = Math.min(100, Math.max(5, pageSize));
  const offset = (safePage - 1) * safePageSize;
  const slice = names.slice(offset, offset + safePageSize);
  const dir = domainDir(domain);

  const rows = slice.map((name) => {
    const absolute = path.join(dir, name);
    let size = 0;
    let mtime = '';
    try {
      const stat = fs.statSync(absolute);
      size = stat.size;
      mtime = stat.mtime.toISOString();
    } catch {
      // keep defaults
    }
    const relativePath = toPosix(path.posix.join(domain, name));
    return {
      name,
      relativePath,
      title: peekTitle(absolute, name),
      size,
      mtime
    };
  });

  return { rows, total, page: safePage, pageSize: safePageSize };
}

export function resolveCorpusBrowsePath(relativePath: string): {
  absolutePath: string;
  relativePath: string;
  domain: CorpusBrowseDomain;
  name: string;
} | null {
  const normalized = toPosix(relativePath || '').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) {
    return null;
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [domain, name] = parts;
  if (!isCorpusBrowseDomain(domain) || !MD_RE.test(name) || name.includes('\\')) return null;

  const root = path.resolve(getCorpusRoot());
  const absolutePath = path.resolve(root, domain, name);
  if (!isUnder(root, absolutePath)) return null;
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return null;

  return {
    absolutePath,
    relativePath: `${domain}/${name}`,
    domain,
    name
  };
}

export function readCorpusBrowseFile(relativePath: string): {
  relativePath: string;
  name: string;
  title: string;
  size: number;
  mtime: string;
  content: string;
  truncated: boolean;
} | null {
  const resolved = resolveCorpusBrowsePath(relativePath);
  if (!resolved) return null;

  const stat = fs.statSync(resolved.absolutePath);
  const truncated = stat.size > MAX_PREVIEW_BYTES;
  const fd = fs.openSync(resolved.absolutePath, 'r');
  try {
    const length = truncated ? MAX_PREVIEW_BYTES : stat.size;
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    const content = buffer.slice(0, bytesRead).toString('utf8');
    return {
      relativePath: resolved.relativePath,
      name: resolved.name,
      title: extractTitle(content, resolved.name),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      content,
      truncated
    };
  } finally {
    fs.closeSync(fd);
  }
}
