import type { WatchedJournal } from './journals';

/** 从各数据源抓到的一篇文章（字段缺失时为空）。 */
export type FetchedArticle = {
  doi: string;
  journalCode: string;
  title: string;
  authors?: string;
  abstract?: string;
  abstractSource?: string;
  keywords?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  pubDate?: string;
  url?: string;
  /** 出版商内部编号，例如 Elsevier 的 PII，用来对上下载的 PDF 文件名 */
  altId?: string;
  openAccess?: boolean;
  oaPdfUrl?: string;
};

export type ArticleEnrichment = Partial<Pick<FetchedArticle, 'abstract' | 'abstractSource' | 'keywords' | 'authors' | 'openAccess' | 'oaPdfUrl'>>;

export class IeeeKeyInactiveError extends Error {
  constructor(message = 'IEEE Xplore API key 尚未激活（Developer Inactive）') {
    super(message);
    this.name = 'IeeeKeyInactiveError';
  }
}

const USER_AGENT = 'ai4es-journal-watch/1.0';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeDoi(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .toLowerCase();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** 去掉 JATS / HTML 标签与实体，压成单行空白。 */
export function cleanMarkup(value: unknown) {
  return String(value || '')
    .replace(/<jats:title>[^<]*<\/jats:title>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(url: string, init: RequestInit = {}, attempts = 3): Promise<{ status: number; body: unknown; text: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(60_000)
      });
      const text = await response.text();
      if ((response.status === 429 || response.status >= 500) && attempt < attempts) {
        await sleep(2_000 * attempt);
        continue;
      }
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      return { status: response.status, body, text };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(2_000 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function ieeeArnumber(url: string | undefined) {
  return url?.match(/ieeexplore\.ieee\.org\/document\/(\d+)/)?.[1];
}

/** 只接受精确到日的日期；只有年份（IEEE 常见）时返回空，交给下一个来源。 */
function ymd(parts: unknown, requireDay = true) {
  const dateParts = (parts as { 'date-parts'?: number[][] } | undefined)?.['date-parts']?.[0];
  if (!dateParts?.[0]) return '';
  if (requireDay && dateParts.length < 3) return '';
  const [year, month = 1, day = 1] = dateParts;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

type CrossrefItem = {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  created?: { 'date-time'?: string };
  'published-online'?: unknown;
  'published-print'?: unknown;
  issued?: unknown;
  volume?: string;
  issue?: string;
  page?: string;
  'article-number'?: string;
  URL?: string;
  'alternative-id'?: string[];
  resource?: { primary?: { URL?: string } };
  license?: Array<{ URL?: string }>;
  abstract?: string;
};

const CROSSREF_SELECT = [
  'DOI', 'title', 'author', 'created', 'resource', 'published-online', 'published-print', 'issued', 'volume', 'issue',
  'page', 'article-number', 'URL', 'alternative-id', 'license', 'abstract'
].join(',');

/** Crossref：出版商登记 DOI 的地方，新文章清单最全（但基本不带摘要）。 */
export async function fetchCrossrefArticles(journal: WatchedJournal, sinceDate: string, maxPages = 50) {
  const mailto = process.env.JOURNAL_WATCH_MAILTO?.trim();
  const articles: FetchedArticle[] = [];
  let cursor = '*';
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      filter: `from-created-date:${sinceDate},type:journal-article`,
      rows: '200',
      cursor,
      select: CROSSREF_SELECT
    });
    if (mailto) params.set('mailto', mailto);
    const { status, body, text } = await fetchJson(`https://api.crossref.org/journals/${journal.issn[0]}/works?${params}`);
    if (status !== 200) throw new Error(`Crossref ${journal.code} HTTP ${status}: ${text.slice(0, 200)}`);
    const message = (body as { message?: { items?: CrossrefItem[]; 'next-cursor'?: string } }).message;
    const items = message?.items || [];
    for (const item of items) {
      const doi = normalizeDoi(item.DOI);
      const title = cleanMarkup(item.title?.[0]);
      if (!doi || !title) continue;
      const authors = (item.author || [])
        .map((author) => author.name || [author.given, author.family].filter(Boolean).join(' '))
        .filter(Boolean)
        .join('; ');
      const abstract = cleanMarkup(item.abstract);
      const openAccess = (item.license || []).some((license) => /creativecommons\.org/i.test(license.URL || ''));
      articles.push({
        doi,
        journalCode: journal.code,
        title,
        authors: authors || undefined,
        abstract: abstract || undefined,
        abstractSource: abstract ? 'crossref' : undefined,
        volume: item.volume,
        issue: item.issue,
        pages: item.page || item['article-number'],
        // 用上线日期：Elsevier 的 issued 是未来某期的封面日期，不适合排“新文章”
        pubDate: ymd(item['published-online']) || item.created?.['date-time']?.slice(0, 10) || ymd(item.issued, false) || undefined,
        url: `https://doi.org/${doi}`,
        // IEEE 记文章编号（arnumber，下载开放获取 PDF 用），Elsevier 记 PII
        altId: ieeeArnumber(item.resource?.primary?.URL) || item['alternative-id']?.[0],
        openAccess: openAccess || journal.openAccess
      });
    }
    const next = message?.['next-cursor'];
    if (!items.length || !next || items.length < 200) break;
    cursor = next;
    await sleep(200);
  }
  return articles;
}

function invertedIndexToText(index: Record<string, number[]> | null | undefined) {
  if (!index) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(' ');
}

type OpenAlexWork = {
  doi?: string;
  abstract_inverted_index?: Record<string, number[]> | null;
  keywords?: Array<{ display_name?: string }>;
  open_access?: { is_oa?: boolean };
  best_oa_location?: { pdf_url?: string | null } | null;
};

/** OpenAlex：按 DOI 批量补摘要和关键词（Elsevier 期刊覆盖较好）。 */
export async function fetchOpenAlexEnrichment(dois: string[]) {
  const result = new Map<string, ArticleEnrichment>();
  const key = process.env.OPENALEX_API_KEY?.trim();
  for (let i = 0; i < dois.length; i += 50) {
    const batch = dois.slice(i, i + 50);
    const params = new URLSearchParams({
      filter: `doi:${batch.map((doi) => `https://doi.org/${doi}`).join('|')}`,
      per_page: '50',
      select: 'doi,abstract_inverted_index,keywords,open_access,best_oa_location'
    });
    const { status, body, text } = await fetchJson(`https://api.openalex.org/works?${params}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {}
    });
    if (status !== 200) throw new Error(`OpenAlex HTTP ${status}: ${text.slice(0, 200)}`);
    for (const work of (body as { results?: OpenAlexWork[] }).results || []) {
      const doi = normalizeDoi(work.doi);
      if (!doi) continue;
      const abstract = invertedIndexToText(work.abstract_inverted_index);
      const keywords = (work.keywords || []).map((item) => item.display_name).filter(Boolean).join('; ');
      result.set(doi, {
        abstract: abstract || undefined,
        abstractSource: abstract ? 'openalex' : undefined,
        keywords: keywords || undefined,
        oaPdfUrl: work.best_oa_location?.pdf_url || undefined
      });
    }
    await sleep(150);
  }
  return result;
}

type IeeeArticle = {
  doi?: string;
  abstract?: string;
  access_type?: string;
  pdf_url?: string;
  authors?: { authors?: Array<{ full_name?: string }> };
  index_terms?: Record<string, { terms?: string[] } | undefined>;
};

function compactDate(date: string) {
  return date.replace(/-/g, '');
}

/** IEEE Xplore 官方 API：摘要、关键词、完整作者，以及开放获取文章的 PDF 地址。 */
export async function fetchIeeeEnrichment(journal: WatchedJournal, sinceDate: string, untilDate: string, maxPages = 10) {
  const apiKey = process.env.IEEE_XPLORE_API_KEY?.trim();
  const result = new Map<string, ArticleEnrichment>();
  if (!apiKey) return result;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      apikey: apiKey,
      format: 'json',
      issn: journal.issn[0],
      start_date: compactDate(sinceDate),
      end_date: compactDate(untilDate),
      max_records: '200',
      start_record: String(page * 200 + 1)
    });
    const { status, body, text } = await fetchJson(`https://ieeexploreapi.ieee.org/api/v1/search/articles?${params}`, {}, 2);
    if (status === 403 && /inactive/i.test(text)) throw new IeeeKeyInactiveError();
    if (status !== 200) throw new Error(`IEEE Xplore ${journal.code} HTTP ${status}: ${text.slice(0, 200)}`);
    const payload = body as { total_records?: number; articles?: IeeeArticle[] };
    const articles = payload.articles || [];
    for (const article of articles) {
      const doi = normalizeDoi(article.doi);
      if (!doi) continue;
      const abstract = cleanMarkup(article.abstract);
      const terms = Object.values(article.index_terms || {}).flatMap((group) => group?.terms || []);
      const keywords = [...new Set(terms.map((term) => term.trim()).filter(Boolean))].join('; ');
      const authors = (article.authors?.authors || []).map((author) => author.full_name).filter(Boolean).join('; ');
      const openAccess = /open/i.test(article.access_type || '');
      result.set(doi, {
        abstract: abstract || undefined,
        abstractSource: abstract ? 'ieee' : undefined,
        keywords: keywords || undefined,
        authors: authors || undefined,
        openAccess,
        oaPdfUrl: openAccess ? article.pdf_url : undefined
      });
    }
    if (articles.length < 200 || (payload.total_records ?? 0) <= (page + 1) * 200) break;
    await sleep(300);
  }
  return result;
}

const MAX_PDF_BYTES = 80 * 1024 * 1024;

/** 下载一个 PDF；返回内容，不是 PDF 时抛错。 */
async function downloadPdf(url: string) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_PDF_BYTES) throw new Error('PDF 太大');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('返回的不是 PDF');
  return bytes;
}

/** IEEE Xplore 上的开放获取文章：stamp 页给出 PDF 地址。非开放获取文章拿不到地址。 */
export async function downloadIeeeOpenAccessPdf(arnumber: string) {
  const response = await fetch(`https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${encodeURIComponent(arnumber)}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(60_000)
  });
  const html = await response.text();
  const src = html.match(/src="(https:\/\/ieeexplore\.ieee\.org\/ielx[^"]+)"/)?.[1];
  if (!src) throw new Error(`IEEE 没有给出 PDF（HTTP ${response.status}），可能不是开放获取`);
  return downloadPdf(src.replace(/&amp;/g, '&'));
}

/** 开放仓储（arXiv 等）的 PDF。ScienceDirect 网页不自动下载。 */
export async function downloadRepositoryPdf(url: string) {
  return downloadPdf(url);
}

export function isAutoDownloadableUrl(url: string | null | undefined) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return !/(^|\.)(sciencedirect\.com|elsevier\.com|ieeexplore\.ieee\.org)$/i.test(host);
  } catch {
    return false;
  }
}
