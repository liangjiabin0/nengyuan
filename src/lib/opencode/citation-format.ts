/** Shared citation path/URL helpers (no Node fs — safe for client + server). */

/**
 * Any relative file path the model might cite, with optional :line / :start-end.
 * Intentionally broad: resolution (server) decides whether the file exists.
 * Do NOT whitelist corpus domains here — that is what caused endless patches.
 */
const CITED_FILE_PATH =
  String.raw`(?:(?:knowledge-corpus|storage)\/)?(?:[A-Za-z0-9._\-]+\/)*[A-Za-z0-9._\-]+\.(?:md|markdown|json|txt|csv|ya?ml|pdf)`;

export const OPENCODE_CITATION_FIND_RE = new RegExp(
  String.raw`(${CITED_FILE_PATH})(?::(\d+)(?:-(\d+))?)?`,
  'gi'
);

export const OPENCODE_BRACKET_CITATION_RE = new RegExp(
  String.raw`\[(${CITED_FILE_PATH})(?::(\d+)(?:-(\d+))?)?\](?!\()`,
  'gi'
);

/** @deprecated kept for older tests / imports — same as FIND body without line suffix concept */
export const OPENCODE_RECORD_PATH = CITED_FILE_PATH;

export const URL_BRACKET_CITATION_RE = /\[((?:https?:\/\/)[^\s\]]+)\]/gi;
export const MARKDOWN_URL_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;
export const BARE_URL_RE = /(?<![(\[])(https?:\/\/[^\s\]\)<>"'*]+)/gi;
/** Scheme-less web hosts in brackets, e.g. [news.pdsu.edu.cn/info/1.htm] / [catswing.cn] */
export const HOST_BRACKET_CITATION_RE =
  /\[(((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s\]]*)?))\]/gi;

const HASH_MD_RE = /^[a-f0-9]{24}\.md$/i;
const PATENT_UUID_DIR_RE =
  /^(patents\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/(?:opencode\/)?(.+)$/i;

export function normalizeCitationPath(value: string) {
  let normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^storage\//, '');
  if (normalized.startsWith('knowledge-corpus/')) {
    normalized = normalized.slice('knowledge-corpus/'.length);
  }
  return normalized;
}

export function pathBasename(value: string) {
  const normalized = normalizeCitationPath(value);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

/**
 * Expand path spellings models actually emit so rewrite/linkify can match
 * whatever form was stored on the DisplaySource.
 */
export function citationPathAliases(rawPath: string): string[] {
  const aliases = new Set<string>();
  const raw = String(rawPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) return [];
  aliases.add(raw);
  aliases.add(normalizeCitationPath(raw));
  if (!raw.startsWith('knowledge-corpus/') && !raw.startsWith('storage/')) {
    aliases.add(`knowledge-corpus/${normalizeCitationPath(raw)}`);
  }

  const normalized = normalizeCitationPath(raw);
  aliases.add(normalized);

  const patent = PATENT_UUID_DIR_RE.exec(normalized);
  if (patent) {
    const root = patent[1];
    const file = patent[2];
    aliases.add(`${root}/${file}`);
    aliases.add(`${root}/opencode/${file}`);
    aliases.add(`opencode/${file}`);
    aliases.add(file);
  } else if (normalized.startsWith('opencode/')) {
    aliases.add(normalized.slice('opencode/'.length));
  }

  const base = pathBasename(normalized);
  if (HASH_MD_RE.test(base)) aliases.add(base);

  return [...aliases].filter(Boolean);
}

export function normalizeCitationUrl(value: string) {
  return String(value || '')
    .trim()
    .replace(/^[*_~`]+/, '')
    .replace(/[),.，。；;*_~`]+$/g, '')
    .replace(/\/+$/, '');
}

/** Coerce raw citation text into an absolute http(s) URL, or '' if not a web link. */
export function coerceCitationUrl(raw: string) {
  const cleaned = normalizeCitationUrl(raw);
  if (!cleaned) return '';
  if (/^https?:\/\//i.test(cleaned)) return normalizeCitationUrl(cleaned);
  // Avoid treating local files / hash names as hosts (.md looks like a TLD).
  if (/\.(?:md|markdown|json|txt|csv|ya?ml|pdf)(?:$|:)/i.test(cleaned)) return '';
  if (/^[a-f0-9]{24}(?:\.md)?$/i.test(cleaned)) return '';
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[:\/]|$)/i.test(cleaned)) return `https://${cleaned}`;
  return '';
}

export type CitationLinkSource = {
  id?: string;
  corpusPath?: string;
  /** Alternate path spellings that should map to this source. */
  pathAliases?: string[];
  matchReason?: string;
  url?: string;
};

export type LinkCitationSource = CitationLinkSource & {
  id: string;
  label: string;
  title: string;
  fileName: string;
  sourceType: 'link';
  sourceKey: string;
  fileKey: string;
  filePath: string;
  fileKind: 'none';
  previewUrl: string;
  snippet: string;
  score: number;
  matchReason: string;
  url: string;
  evidenceIds: string[];
};

function sourcePathAliasSet(source: CitationLinkSource) {
  const set = new Set<string>();
  for (const value of source.pathAliases || []) {
    for (const alias of citationPathAliases(value)) set.add(alias);
  }
  if (source.corpusPath) {
    for (const alias of citationPathAliases(source.corpusPath)) set.add(alias);
  }
  return set;
}

function aliasesCompatible(citePath: string, source: CitationLinkSource) {
  const citeAliases = citationPathAliases(citePath);
  const sourceAliases = sourcePathAliasSet(source);
  const overlap = citeAliases.filter((alias) => sourceAliases.has(alias));
  if (!overlap.length) {
    const base = pathBasename(citePath);
    // Unique corpus hash filenames may be cited without a domain folder.
    if (HASH_MD_RE.test(base) && sourceAliases.has(base)) return true;
    return false;
  }
  // Reject overlap that is only a shared generic basename (SOURCE.md, META.json, …).
  return overlap.some((alias) => alias.includes('/') || HASH_MD_RE.test(alias));
}

export function findSourceForPath<T extends CitationLinkSource>(
  sources: T[],
  rawPath: string,
  startLine?: string,
  endLine?: string
): T | undefined {
  const relativePath = normalizeCitationPath(rawPath);
  if (startLine) {
    const start = Number(startLine);
    const end = Number(endLine || startLine);
    const exact = sources.find((source) => {
      if (!source.corpusPath && !(source.pathAliases || []).length) return false;
      if (!aliasesCompatible(relativePath, source)) return false;
      const reason = source.matchReason || '';
      const aliasPool = [...sourcePathAliasSet(source)];
      return aliasPool.some(
        (alias) =>
          reason.includes(`${alias}:${start}-${end}`)
          || reason.includes(`${alias}:${start}`)
      ) || reason.includes(`${pathBasename(relativePath)}:${start}`);
    });
    if (exact) return exact;
  }
  return sources.find((source) => {
    if (!source.corpusPath && !(source.pathAliases || []).length) return false;
    return aliasesCompatible(relativePath, source);
  });
}

function findSourceForUrl(sources: CitationLinkSource[], rawUrl: string) {
  const url = coerceCitationUrl(rawUrl) || normalizeCitationUrl(rawUrl);
  if (!url) return undefined;
  return sources.find((source) => {
    const candidate = coerceCitationUrl(source.url || '') || normalizeCitationUrl(source.url || '');
    return candidate === url;
  });
}

export function extractLinkCitations(answer: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const url = coerceCitationUrl(raw);
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };
  const text = String(answer || '');
  for (const match of text.matchAll(MARKDOWN_URL_LINK_RE)) add(match[2]);
  for (const match of text.matchAll(URL_BRACKET_CITATION_RE)) add(match[1]);
  for (const match of text.matchAll(HOST_BRACKET_CITATION_RE)) add(match[1]);
  for (const match of text.matchAll(BARE_URL_RE)) add(match[1]);
  return urls;
}

export function resolveLinkCitations(urls: string[], startIndex = 1): LinkCitationSource[] {
  return urls.slice(0, 40).map((url, index) => {
    const id = `L${startIndex + index}`;
    let hostPath = url;
    try {
      const parsed = new URL(url);
      hostPath = `${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '') || url;
    } catch {
      /* keep raw */
    }
    return {
      id,
      label: id,
      title: url,
      fileName: hostPath.slice(0, 96),
      sourceType: 'link',
      sourceKey: url,
      fileKey: `link:${id}`,
      filePath: url,
      fileKind: 'none',
      previewUrl: url,
      snippet: url,
      score: 1,
      matchReason: '网页链接引用',
      url,
      evidenceIds: [id]
    };
  });
}

function looksLikeUrlPath(rawPath: string) {
  if (/^https?:\/\//i.test(rawPath)) return true;
  // Hash/corpus filenames like abcdef….md must NOT be treated as hosts.
  if (/\.(?:md|markdown|json|txt|csv|ya?ml|pdf)(?:$|:|\/)/i.test(rawPath)) return false;
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(rawPath);
}

/** Replace resolved path citations with `[E#]`; drop unresolved path brackets so UI never shows raw paths. */
export function rewritePathCitationsToLabels(
  content: string,
  sources: CitationLinkSource[] = []
) {
  let text = String(content || '').replace(
    OPENCODE_BRACKET_CITATION_RE,
    (full, rawPath: string, startLine?: string, endLine?: string) => {
      if (looksLikeUrlPath(rawPath)) return full;
      const matched = findSourceForPath(sources, rawPath, startLine, endLine);
      return matched?.id ? `[${matched.id}]` : '';
    }
  );

  // Bare path citations (no brackets) that resolved to a source.
  text = text.replace(
    OPENCODE_CITATION_FIND_RE,
    (full, rawPath: string, startLine?: string, endLine?: string) => {
      if (looksLikeUrlPath(rawPath)) return full;
      // Skip if this match is already inside a remaining [...] that we did not own
      // (URLs / markdown). Resolved bracket cites are already [E#].
      const matched = findSourceForPath(sources, rawPath, startLine, endLine);
      return matched?.id ? `[${matched.id}]` : full;
    }
  );

  return text.replace(/[ \t]{2,}/g, ' ').replace(/ ?([，。；、,.])/g, '$1');
}

/** Replace URL citations / markdown links / host brackets with short `[L1]` labels. */
export function rewriteUrlCitationsToLabels(
  content: string,
  sources: CitationLinkSource[] = []
) {
  let text = String(content || '');
  text = text.replace(MARKDOWN_URL_LINK_RE, (full, _label: string, rawUrl: string) => {
    const matched = findSourceForUrl(sources, rawUrl);
    return matched?.id ? `[${matched.id}]` : full;
  });
  text = text.replace(URL_BRACKET_CITATION_RE, (full, rawUrl: string) => {
    const matched = findSourceForUrl(sources, rawUrl);
    return matched?.id ? `[${matched.id}]` : full;
  });
  text = text.replace(HOST_BRACKET_CITATION_RE, (full, rawHost: string) => {
    if (/\.(?:md|markdown|json|txt|csv|ya?ml|pdf)(?:$|:)/i.test(rawHost)) return full;
    const matched = findSourceForUrl(sources, rawHost);
    return matched?.id ? `[${matched.id}]` : full;
  });
  text = text.replace(BARE_URL_RE, (rawUrl: string) => {
    const matched = findSourceForUrl(sources, rawUrl);
    return matched?.id ? `[${matched.id}]` : rawUrl;
  });
  return text;
}

export function rewriteAllCitationsToLabels(
  content: string,
  sources: CitationLinkSource[] = []
) {
  return rewriteUrlCitationsToLabels(rewritePathCitationsToLabels(content, sources), sources);
}

/** Turn [E1]/[L1] into markdown links. Never render raw filesystem paths as labels. */
export function linkifyOpenCodeCitations(
  content: string,
  sources: CitationLinkSource[] = []
) {
  const shortened = rewriteAllCitationsToLabels(content, sources);
  let text = shortened.replace(/\[E(\d+)\]/gi, (_full, num: string) => `[E${num}](#cite-E${num})`);
  text = text.replace(/\[L(\d+)\]/gi, (_full, num: string) => `[L${num}](#cite-L${num})`);
  // Any leftover path brackets (unresolved) are removed — do not show path labels.
  text = text.replace(OPENCODE_BRACKET_CITATION_RE, (full, rawPath: string) => {
    if (looksLikeUrlPath(rawPath)) return full;
    return '';
  });
  return text.replace(/[ \t]{2,}/g, ' ').replace(/ ?([，。；、,.])/g, '$1');
}

export function parsePathCitationId(id: string) {
  if (!id.startsWith('path:')) return null;
  const body = id.slice('path:'.length);
  const match = /^(.*?):(\d+)-(\d+)$/.exec(body);
  if (!match) return null;
  return {
    path: match[1],
    startLine: Number(match[2]),
    endLine: Number(match[3])
  };
}

/** @deprecated use citationPathAliases */
export function patentWorkspacePathAliases(value: string) {
  return citationPathAliases(value);
}
