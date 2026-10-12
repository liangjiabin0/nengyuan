import { all, get } from '../db';
import { WATCHED_JOURNALS } from './journals';
import type { JournalWatchArticleRow, JournalWatchSummary } from './run';

export type JournalWatchListQuery = {
  journal?: string;
  days?: number;
  q?: string;
  status?: 'all' | 'abstract' | 'title-only' | 'fulltext';
  page?: number;
  pageSize?: number;
};

export type JournalWatchArticle = {
  doi: string;
  journalCode: string;
  title: string;
  authors: string;
  abstract: string;
  keywords: string;
  pubDate: string;
  volume: string;
  issue: string;
  pages: string;
  url: string;
  openAccess: boolean;
  oaPdfUrl: string;
  fulltext: boolean;
  /** upload / ieee-oa / arxiv / oa-repository */
  pdfSource: string;
  paperKey: string;
  firstSeenAt: string;
};

function toArticle(row: JournalWatchArticleRow): JournalWatchArticle {
  return {
    doi: row.doi,
    journalCode: row.journal_code,
    title: row.title,
    authors: row.authors || '',
    abstract: row.abstract || '',
    keywords: row.keywords || '',
    pubDate: row.pub_date || '',
    volume: row.volume || '',
    issue: row.issue || '',
    pages: row.pages || '',
    url: row.url || `https://doi.org/${row.doi}`,
    openAccess: Boolean(row.open_access),
    oaPdfUrl: row.oa_pdf_url || '',
    fulltext: Boolean(row.fulltext),
    pdfSource: row.pdf_source || '',
    paperKey: row.paper_key || '',
    firstSeenAt: row.first_seen_at
  };
}

export async function listJournalWatchArticles(query: JournalWatchListQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.journal) {
    where.push('journal_code = ?');
    params.push(query.journal);
  }
  if (query.days && query.days > 0) {
    where.push('first_seen_at >= ?');
    params.push(new Date(Date.now() - query.days * 86_400_000).toISOString());
  }
  if (query.status === 'fulltext') where.push('fulltext = 1');
  if (query.status === 'abstract') where.push("fulltext = 0 AND abstract IS NOT NULL AND abstract <> ''");
  if (query.status === 'title-only') where.push("fulltext = 0 AND (abstract IS NULL OR abstract = '')");
  const needle = query.q?.trim();
  if (needle) {
    where.push('(lower(title) LIKE ? OR lower(authors) LIKE ? OR lower(keywords) LIKE ? OR lower(abstract) LIKE ? OR doi = ?)');
    const like = `%${needle.toLowerCase()}%`;
    params.push(like, like, like, like, needle.toLowerCase());
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(200, Math.max(10, query.pageSize || 50));
  const page = Math.max(1, query.page || 1);
  const total = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM journal_watch_articles ${clause}`, params);
  const rows = await all<JournalWatchArticleRow>(
    `SELECT * FROM journal_watch_articles ${clause}
     ORDER BY COALESCE(pub_date, '') DESC, first_seen_at DESC, doi
     LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  );
  return { total: Number(total?.n || 0), page, pageSize, articles: rows.map(toArticle) };
}

export async function getJournalWatchOverview() {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const counts = await all<{ journal_code: string; total: number; week: number; with_abstract: number; fulltext: number }>(
    `SELECT journal_code,
            COUNT(*) AS total,
            SUM(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END) AS week,
            SUM(CASE WHEN abstract IS NOT NULL AND abstract <> '' THEN 1 ELSE 0 END) AS with_abstract,
            SUM(fulltext) AS fulltext
     FROM journal_watch_articles GROUP BY journal_code`,
    [weekAgo]
  );
  const byCode = new Map(counts.map((row) => [row.journal_code, row]));
  const lastRun = await get<{ id: string; trigger: string; status: string; started_at: string; finished_at: string | null; summary_json: string | null; error: string | null }>(
    'SELECT * FROM journal_watch_runs ORDER BY started_at DESC LIMIT 1'
  );
  let summary: JournalWatchSummary | null = null;
  try {
    summary = lastRun?.summary_json ? JSON.parse(lastRun.summary_json) : null;
  } catch {
    summary = null;
  }
  return {
    journals: WATCHED_JOURNALS.map((journal) => {
      const row = byCode.get(journal.code);
      return {
        code: journal.code,
        name: journal.name,
        shortName: journal.shortName,
        publisher: journal.publisher,
        openAccess: journal.openAccess,
        total: Number(row?.total || 0),
        week: Number(row?.week || 0),
        withAbstract: Number(row?.with_abstract || 0),
        fulltext: Number(row?.fulltext || 0)
      };
    }),
    lastRun: lastRun
      ? {
          trigger: lastRun.trigger,
          status: lastRun.status,
          startedAt: lastRun.started_at,
          finishedAt: lastRun.finished_at,
          error: lastRun.error,
          summary
        }
      : null,
    keys: {
      ieee: Boolean(process.env.IEEE_XPLORE_API_KEY?.trim()),
      openalex: Boolean(process.env.OPENALEX_API_KEY?.trim())
    }
  };
}
