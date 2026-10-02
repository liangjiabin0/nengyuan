import fs from 'node:fs';
import path from 'node:path';
import { getCorpusRoot } from '../corpus/schema';
import type { DisplaySource } from '../source-files';
import {
  OPENCODE_CITATION_FIND_RE,
  citationPathAliases,
  extractLinkCitations,
  normalizeCitationPath,
  pathBasename,
  resolveLinkCitations
} from './citation-format';

export { extractLinkCitations, resolveLinkCitations };

const CORPUS_DOMAINS = [
  'papers',
  'patents',
  'books',
  'projects',
  'national-projects',
  'people',
  'outputs',
  'mentors',
  'attachments'
] as const;

const HASH_MD_RE = /^[a-f0-9]{24}\.md$/i;
const TEXT_FILE_RE = /\.(?:md|markdown|json|txt|csv|ya?ml|pdf)$/i;

export type OpenCodeCitation = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  /** True when the model omitted `:line` and we inferred a snippet range. */
  lineOptional?: boolean;
};

export type ResolvedOpenCodeCitations = {
  sources: DisplaySource[];
  invalid: string[];
};

export type ResolveCitationOptions = {
  /** OpenCode session cwd — used to resolve relative cites like opencode/SOURCE.md */
  workingDirectory?: string;
};

type ResolvedFileHit = {
  absolutePath: string;
  /** Path spelling to store for rewrite matching (prefer the cited form). */
  displayPath: string;
  pathAliases: string[];
};

function isUnder(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseScalar(value: string) {
  const text = value.trim();
  if (text === 'null' || !text) return '';
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  try {
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? '' : String(parsed);
  } catch {
    return text.replace(/^['"]|['"]$/g, '');
  }
}

function parseFrontmatter(lines: string[]) {
  const fields: Record<string, string> = {};
  if (lines[0]?.trim() !== '---') return fields;
  for (let index = 1; index < Math.min(lines.length, 100); index += 1) {
    const line = lines[index];
    if (line.trim() === '---') break;
    const match = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = parseScalar(match[2]);
  }
  return fields;
}

function defaultSnippetRange(lines: string[]) {
  let start = 1;
  if (lines[0]?.trim() === '---') {
    for (let index = 1; index < Math.min(lines.length, 120); index += 1) {
      if (lines[index]?.trim() === '---') {
        start = index + 2;
        break;
      }
    }
  }
  while (start <= lines.length && !String(lines[start - 1] || '').trim()) start += 1;
  if (start > lines.length) start = 1;
  const end = Math.min(lines.length, start + 14);
  return { start, end: Math.max(start, end) };
}

function fileKind(filePath: string): DisplaySource['fileKind'] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  return filePath ? 'text' : 'none';
}

function sourceType(kind: string) {
  if (kind === 'patent') return 'paper';
  if (kind === 'person') return 'entity';
  if (kind === 'attachment') return 'attachment';
  if (kind === 'patent-workspace') return 'patent-workspace';
  return kind || 'corpus';
}

function previewUrl(fields: Record<string, string>, type: string, key: string) {
  if (type === 'attachment' && fields.attachment_id && fields.conversation_id) {
    return `/api/chat/attachments/${encodeURIComponent(fields.attachment_id)}/preview?conversationId=${encodeURIComponent(fields.conversation_id)}`;
  }
  if (!['paper', 'mentor', 'project'].includes(type)) return '';
  return `/api/files/preview?${new URLSearchParams({ sourceType: type, sourceKey: key }).toString()}`;
}

function firstMarkdownHeading(lines: string[]) {
  for (const line of lines.slice(0, 40)) {
    const match = /^#{1,3}\s+(.+)$/.exec(line.trim());
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function looksLikeUrlPath(rawPath: string) {
  if (/^https?:\/\//i.test(rawPath)) return true;
  if (/\.(?:md|markdown|json|txt|csv|ya?ml|pdf)(?:$|:|\/)/i.test(rawPath)) return false;
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(rawPath);
}

/** Generate relative path spellings to probe on disk. */
function expandRelativeCandidates(rawPath: string): string[] {
  const out = new Set<string>();
  const raw = String(rawPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || looksLikeUrlPath(raw) || path.isAbsolute(raw) || /^[a-z]:/i.test(raw)) {
    return [];
  }

  for (const alias of citationPathAliases(raw)) {
    out.add(alias.replace(/^storage\//, '').replace(/^knowledge-corpus\//, ''));
    out.add(alias);
  }

  const normalized = normalizeCitationPath(raw);
  out.add(normalized);

  const base = pathBasename(normalized);
  if (HASH_MD_RE.test(base)) {
    for (const domain of CORPUS_DOMAINS) out.add(`${domain}/${base}`);
  }

  return [...out].filter((item) => item && TEXT_FILE_RE.test(item));
}

function toPosix(value: string) {
  return value.replace(/\\/g, '/');
}

function relativeToRoot(root: string, absolutePath: string) {
  return toPosix(path.relative(root, absolutePath));
}

/**
 * Resolve a model-cited path against local storage roots.
 * No domain whitelist — if the file exists under an allowed root, it counts.
 */
export function resolveCitationFile(
  rawPath: string,
  options: ResolveCitationOptions = {}
): ResolvedFileHit | null {
  const citedRaw = String(rawPath || '').replace(/\\/g, '/');
  if (!citedRaw || looksLikeUrlPath(citedRaw)) return null;

  const cwd = process.cwd();
  const storageRoot = path.resolve(cwd, 'storage');
  const corpusRoot = path.resolve(getCorpusRoot());
  const patentsRoot = path.resolve(storageRoot, 'patents');
  const workingDirectory = options.workingDirectory
    ? path.resolve(options.workingDirectory)
    : '';

  const roots = [corpusRoot, storageRoot, patentsRoot, cwd];
  if (workingDirectory) roots.unshift(workingDirectory);

  const relatives = expandRelativeCandidates(citedRaw);
  const absoluteTried = new Set<string>();

  const tryAbsolute = (absolutePath: string): ResolvedFileHit | null => {
    const resolved = path.resolve(absolutePath);
    if (absoluteTried.has(resolved)) return null;
    absoluteTried.add(resolved);

    const allowed =
      isUnder(corpusRoot, resolved)
      || isUnder(storageRoot, resolved)
      || (workingDirectory ? isUnder(workingDirectory, resolved) : false);
    if (!allowed || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return null;
    }

    const aliases = new Set<string>(citationPathAliases(citedRaw));
    if (isUnder(corpusRoot, resolved)) {
      aliases.add(relativeToRoot(corpusRoot, resolved));
    }
    if (isUnder(storageRoot, resolved)) {
      aliases.add(relativeToRoot(storageRoot, resolved));
    }
    if (workingDirectory && isUnder(workingDirectory, resolved)) {
      aliases.add(relativeToRoot(workingDirectory, resolved));
    }
    aliases.add(path.basename(resolved));

    const displayPath =
      normalizeCitationPath(citedRaw)
      || (isUnder(corpusRoot, resolved) ? relativeToRoot(corpusRoot, resolved) : relativeToRoot(storageRoot, resolved));

    return {
      absolutePath: resolved,
      displayPath,
      pathAliases: [...aliases].filter(Boolean)
    };
  };

  for (const rel of relatives) {
    const posixRel = toPosix(rel).replace(/^storage\//, '');
    for (const root of roots) {
      const hit = tryAbsolute(path.join(root, posixRel));
      if (hit) return hit;
    }
    // storage/patents/... when rel is patents/...
    if (posixRel.startsWith('patents/')) {
      const hit = tryAbsolute(path.join(storageRoot, posixRel));
      if (hit) return hit;
    }
  }

  // Bare filename relative to patent project / opencode cwd.
  if (workingDirectory) {
    const base = pathBasename(citedRaw);
    if (base && TEXT_FILE_RE.test(base)) {
      for (const candidate of [
        path.join(workingDirectory, base),
        path.join(workingDirectory, 'opencode', base)
      ]) {
        const hit = tryAbsolute(candidate);
        if (hit) return hit;
      }
    }
  }

  return null;
}

function clampLineRange(
  lines: string[],
  citation: OpenCodeCitation
): { startLine: number; endLine: number } {
  if (citation.lineOptional || !citation.startLine) {
    const range = defaultSnippetRange(lines);
    return { startLine: range.start, endLine: range.end };
  }
  const rawStart = Math.floor(Number(citation.startLine));
  const rawEnd = Math.floor(Number(citation.endLine || citation.startLine));
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd < rawStart) {
    const range = defaultSnippetRange(lines);
    return { startLine: range.start, endLine: range.end };
  }
  if (lines.length === 0) {
    return { startLine: 1, endLine: 1 };
  }
  const startLine = Math.min(lines.length, Math.max(1, rawStart));
  const endLine = Math.min(lines.length, Math.max(startLine, rawEnd));
  if (endLine - startLine > 80) {
    return { startLine, endLine: startLine + 80 };
  }
  return { startLine, endLine };
}

function inferKind(absolutePath: string, fields: Record<string, string>): string {
  if (fields.kind) return fields.kind;
  const posix = toPosix(absolutePath);
  if (posix.includes('/storage/patents/') || /[\\/]patents[\\/][^/]+[\\/]opencode[\\/]/i.test(posix)) {
    return 'patent-workspace';
  }
  if (posix.includes(`${path.sep}attachments${path.sep}`) || posix.includes('/attachments/')) {
    return 'attachment';
  }
  for (const domain of CORPUS_DOMAINS) {
    if (posix.includes(`/knowledge-corpus/${domain}/`) || posix.includes(`${path.sep}${domain}${path.sep}`)) {
      if (domain === 'people') return 'person';
      if (domain === 'patents') return 'patent';
      if (domain === 'projects') return 'project';
      if (domain === 'national-projects') return 'nkrd';
      if (domain === 'mentors') return 'mentor';
      if (domain === 'papers' || domain === 'books') return 'paper';
      return domain;
    }
  }
  return 'corpus';
}

export function extractOpenCodeCitations(answer: string): OpenCodeCitation[] {
  const citations: OpenCodeCitation[] = [];
  const seen = new Set<string>();
  for (const match of String(answer || '').replace(/\\/g, '/').matchAll(OPENCODE_CITATION_FIND_RE)) {
    const rawPath = match[1];
    if (!rawPath || looksLikeUrlPath(rawPath)) continue;
    const hasLine = Boolean(match[2]);
    const startLine = hasLine ? Number(match[2]) : 0;
    const endLine = hasLine ? Number(match[3] || match[2]) : 0;
    const key = hasLine ? `${rawPath}:${startLine}-${endLine}` : `${rawPath}:*`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      id: `C${citations.length + 1}`,
      path: rawPath,
      startLine,
      endLine,
      lineOptional: !hasLine
    });
  }
  return citations;
}

export function resolveOpenCodeCitations(
  citations: OpenCodeCitation[],
  options: ResolveCitationOptions = {}
): ResolvedOpenCodeCitations {
  const sources: DisplaySource[] = [];
  const invalid: string[] = [];
  const sourceIndexByKey = new Map<string, number>();

  citations.slice(0, 40).forEach((citation, citationIndex) => {
    const citationId = `C${citationIndex + 1}`;
    try {
      const hit = resolveCitationFile(String(citation.path || ''), options);
      if (!hit) {
        throw new Error('引用文件不存在或超出允许目录');
      }

      const lines = fs.readFileSync(hit.absolutePath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
      const { startLine, endLine } = clampLineRange(lines, citation);
      const fields = parseFrontmatter(lines);
      const kind = inferKind(hit.absolutePath, fields);
      const recordKey =
        fields.record_key
        || `file:${toPosix(hit.absolutePath)}`;
      const existingIndex = sourceIndexByKey.get(recordKey);
      if (existingIndex !== undefined) {
        // Merge aliases onto the existing source so later rewrite forms still match.
        const existing = sources[existingIndex];
        if (existing) {
          const merged = new Set([...(existing.pathAliases || []), ...hit.pathAliases, hit.displayPath]);
          existing.pathAliases = [...merged];
        }
        return;
      }

      const id = `E${sources.length + 1}`;
      const title =
        fields.title
        || fields.name
        || firstMarkdownHeading(lines)
        || path.basename(hit.absolutePath);
      const originalFile = fields.preview_file || fields.source_file || hit.absolutePath;
      const type = sourceType(kind);
      const snippet = lines.slice(startLine - 1, endLine).join('\n').trim().slice(0, 1200);

      sources.push({
        id,
        label: id,
        title,
        fileName: originalFile ? path.basename(originalFile) : path.basename(hit.absolutePath),
        sourceType: type,
        sourceKey: recordKey,
        fileKey: `${kind}:${recordKey}`,
        filePath: originalFile,
        fileKind: fileKind(originalFile),
        previewUrl: previewUrl(fields, type, recordKey),
        snippet,
        score: 1,
        matchReason: citation.lineOptional
          ? `能元 Markdown 引用 ${hit.displayPath}`
          : `能元 Markdown 引用 ${hit.displayPath}:${startLine}-${endLine}`,
        corpusPath: hit.displayPath,
        pathAliases: hit.pathAliases,
        evidenceIds: [id]
      });
      sourceIndexByKey.set(recordKey, sources.length - 1);
    } catch (error) {
      invalid.push(`${citationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return { sources, invalid };
}
