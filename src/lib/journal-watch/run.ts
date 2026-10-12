import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db';
import { all, get, getDb, invalidateDbCaches, run, withTransaction } from '../db';
import { removePaperFromCorpus, syncPaperDocumentsToCorpus } from '../corpus/export';
import { indexPaperDocumentInDb } from '../search-index';
import { findJournal, WATCHED_JOURNALS, type WatchedJournal } from './journals';
import {
  downloadIeeeOpenAccessPdf,
  downloadRepositoryPdf,
  fetchCrossrefArticles,
  fetchIeeeEnrichment,
  fetchOpenAlexEnrichment,
  IeeeKeyInactiveError,
  isAutoDownloadableUrl,
  type ArticleEnrichment,
  type FetchedArticle
} from './sources';

/** 期刊追踪记录在 paper_documents 里的前缀（只有题目/摘要，没有 PDF）。 */
export const JOURNAL_PAPER_PREFIX = 'journal:';

export type JournalWatchArticleRow = {
  doi: string;
  journal_code: string;
  title: string;
  authors: string | null;
  abstract: string | null;
  abstract_source: string | null;
  keywords: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  pub_date: string | null;
  url: string | null;
  alt_id: string | null;
  open_access: number;
  oa_pdf_url: string | null;
  paper_key: string | null;
  fulltext: number;
  pdf_source: string | null;
  pdf_attempts: number;
  pdf_error: string | null;
  first_seen_at: string;
  updated_at: string;
};

export type JournalWatchSummary = {
  sinceDate: string;
  journals: Record<string, { fetched: number; added: number; error?: string }>;
  enriched: { ieee: number; openalex: number };
  ieeeStatus: 'ok' | 'inactive' | 'no-key' | 'error' | 'skipped';
  linked: number;
  synced: number;
  /** 自动下载的开放获取全文 */
  oaDownloaded: number;
  oaFailed: number;
  errors: string[];
};

export type JournalWatchOptions = {
  trigger?: string;
  /** 首次运行（或手动补抓）往前抓多少天 */
  backfillDays?: number;
  journals?: string[];
  onProgress?: (progress: Record<string, unknown>) => void | Promise<void>;
};

const ENRICH_WINDOW_DAYS = 120;
let running = false;

function localDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  return date.toLocaleDateString('sv-SE');
}

function normalizeTitle(value: unknown) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function journalPaperKey(doi: string) {
  return `${JOURNAL_PAPER_PREFIX}${doi}`;
}

async function resolveSinceDate(backfillDays?: number) {
  if (backfillDays && backfillDays > 0) return localDate(-backfillDays);
  const last = await get<{ started_at: string }>(
    `SELECT started_at FROM journal_watch_runs WHERE status = 'done' ORDER BY started_at DESC LIMIT 1`
  );
  if (last?.started_at) {
    // 与上次成功运行重叠 3 天，防止 Crossref 登记延迟漏掉文章
    const since = new Date(new Date(last.started_at).getTime() - 3 * 86_400_000);
    return since.toLocaleDateString('sv-SE');
  }
  const days = Math.max(1, Number(process.env.JOURNAL_WATCH_BACKFILL_DAYS || 30) || 30);
  return localDate(-days);
}

/** 写入或更新文章；返回新增/有变化的 DOI。 */
async function upsertArticles(articles: FetchedArticle[]) {
  const touched = new Set<string>();
  let added = 0;
  const now = new Date().toISOString();
  for (const article of articles) {
    const existing = await get<JournalWatchArticleRow>('SELECT * FROM journal_watch_articles WHERE doi = ?', [article.doi]);
    if (!existing) {
      await run(
        `INSERT INTO journal_watch_articles(
           doi, journal_code, title, authors, abstract, abstract_source, keywords, volume, issue, pages,
           pub_date, url, alt_id, open_access, oa_pdf_url, fulltext, first_seen_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(doi) DO NOTHING`,
        [
          article.doi, article.journalCode, article.title, article.authors ?? null, article.abstract ?? null,
          article.abstractSource ?? null, article.keywords ?? null, article.volume ?? null, article.issue ?? null,
          article.pages ?? null, article.pubDate ?? null, article.url ?? null, article.altId ?? null,
          article.openAccess ? 1 : 0, article.oaPdfUrl ?? null, now, now
        ]
      );
      touched.add(article.doi);
      added += 1;
      continue;
    }
    const next = {
      title: article.title || existing.title,
      authors: article.authors || existing.authors,
      volume: article.volume || existing.volume,
      issue: article.issue || existing.issue,
      pages: article.pages || existing.pages,
      pub_date: article.pubDate || existing.pub_date,
      alt_id: article.altId || existing.alt_id
    };
    const changed = (Object.keys(next) as Array<keyof typeof next>).some((key) => (next[key] ?? null) !== (existing[key] ?? null));
    if (!changed) continue;
    await run(
      `UPDATE journal_watch_articles
       SET title = ?, authors = ?, volume = ?, issue = ?, pages = ?, pub_date = ?, alt_id = ?, updated_at = ?
       WHERE doi = ?`,
      [next.title, next.authors, next.volume, next.issue, next.pages, next.pub_date, next.alt_id, now, article.doi]
    );
    touched.add(article.doi);
  }
  return { touched, added };
}

async function applyEnrichment(enrichment: Map<string, ArticleEnrichment>, touched: Set<string>) {
  let count = 0;
  const now = new Date().toISOString();
  for (const [doi, data] of enrichment) {
    const row = await get<JournalWatchArticleRow>('SELECT * FROM journal_watch_articles WHERE doi = ?', [doi]);
    if (!row) continue;
    const abstract = row.abstract || data.abstract || null;
    const abstractSource = row.abstract ? row.abstract_source : data.abstract ? data.abstractSource ?? null : row.abstract_source;
    const keywords = row.keywords || data.keywords || null;
    // IEEE 的作者列表比 Crossref 完整时才替换
    const authors =
      data.authors && data.authors.split(';').length > String(row.authors || '').split(';').filter(Boolean).length
        ? data.authors
        : row.authors;
    const openAccess = row.open_access || (data.openAccess ? 1 : 0);
    const oaPdfUrl = row.oa_pdf_url || data.oaPdfUrl || null;
    if (
      abstract === row.abstract && keywords === row.keywords && authors === row.authors
      && openAccess === row.open_access && oaPdfUrl === row.oa_pdf_url
    ) continue;
    await run(
      `UPDATE journal_watch_articles
       SET abstract = ?, abstract_source = ?, keywords = ?, authors = ?, open_access = ?, oa_pdf_url = ?, updated_at = ?
       WHERE doi = ?`,
      [abstract, abstractSource, keywords, authors, openAccess, oaPdfUrl, now, doi]
    );
    if (abstract !== row.abstract) count += 1;
    touched.add(doi);
  }
  return count;
}

async function articlesMissingAbstract(journals: WatchedJournal[]) {
  const codes = journals.map((journal) => journal.code);
  if (!codes.length) return [];
  return all<{ doi: string; journal_code: string }>(
    `SELECT doi, journal_code FROM journal_watch_articles
     WHERE (abstract IS NULL OR abstract = '') AND first_seen_at >= ?
       AND journal_code IN (${codes.map(() => '?').join(',')})
     ORDER BY first_seen_at DESC LIMIT 5000`,
    [new Date(Date.now() - ENRICH_WINDOW_DAYS * 86_400_000).toISOString(), ...codes]
  );
}

async function deleteJournalPaper(db: Database, paperKey: string) {
  await db.prepare('DELETE FROM search_records WHERE source_type = ? AND source_key = ?').run('paper', paperKey);
  await db.prepare('DELETE FROM paper_documents WHERE paper_key = ?').run(paperKey);
}

/** 把一篇文章挂到已入库的全文论文上：删掉摘要记录，给全文论文补 DOI / 期刊 / 日期。 */
async function linkArticleToPaper(article: JournalWatchArticleRow, paperKey: string, preferArticleTitle = false) {
  const journal = findJournal(article.journal_code);
  const year = article.pub_date ? Number(article.pub_date.slice(0, 4)) : null;
  const journalKey = journalPaperKey(article.doi);
  await withTransaction(async (db) => {
    await deleteJournalPaper(db, journalKey);
    await db.prepare(
      `UPDATE paper_documents SET
         doi = COALESCE(NULLIF(doi, ''), ?),
         journal = COALESCE(NULLIF(journal, ''), ?),
         pub_date = COALESCE(NULLIF(pub_date, ''), ?),
         publish_year = COALESCE(publish_year, ?),
         abstract = COALESCE(NULLIF(abstract, ''), ?),
         authors = COALESCE(NULLIF(authors, ''), ?),
         keywords = COALESCE(NULLIF(keywords, ''), ?),
         title = CASE WHEN ? = 1 THEN ? ELSE title END,
         updated_at = CURRENT_TIMESTAMP
       WHERE paper_key = ?`
    ).run(
      article.doi, journal?.name ?? null, article.pub_date, year, article.abstract, article.authors, article.keywords,
      preferArticleTitle ? 1 : 0, article.title, paperKey
    );
    const paper = await db.prepare('SELECT * FROM paper_documents WHERE paper_key = ?').get<Record<string, unknown>>(paperKey);
    if (paper) await indexPaperDocumentInDb(db, paper as Parameters<typeof indexPaperDocumentInDb>[1]);
    await db.prepare(
      `UPDATE journal_watch_articles SET fulltext = 1, paper_key = ?, updated_at = ? WHERE doi = ?`
    ).run(paperKey, new Date().toISOString(), article.doi);
  });
  removePaperFromCorpus(journalKey, article.title);
  await syncPaperDocumentsToCorpus(getDb(), { paperKeys: [paperKey] });
}

/** 用 DOI 或题目，把还没有全文的文章与已导入的 PDF 论文对上。 */
async function linkExistingFulltext() {
  const pending = await all<JournalWatchArticleRow>('SELECT * FROM journal_watch_articles WHERE fulltext = 0');
  if (!pending.length) return 0;
  const byDoi = new Map(pending.map((row) => [row.doi, row]));
  const byTitle = new Map(pending.filter((row) => normalizeTitle(row.title).length >= 20).map((row) => [normalizeTitle(row.title), row]));
  const matches = new Map<string, string>();
  const dois = [...byDoi.keys()];
  for (let i = 0; i < dois.length; i += 300) {
    const slice = dois.slice(i, i + 300);
    const rows = await all<{ paper_key: string; doi: string }>(
      `SELECT paper_key, doi FROM paper_documents
       WHERE paper_key NOT LIKE 'journal:%' AND lower(doi) IN (${slice.map(() => '?').join(',')})`,
      slice
    );
    for (const row of rows) matches.set(String(row.doi).toLowerCase(), row.paper_key);
  }
  const titles = [...byTitle.keys()];
  for (let i = 0; i < titles.length; i += 300) {
    const slice = titles.slice(i, i + 300);
    const rows = await all<{ paper_key: string; norm: string }>(
      `SELECT paper_key, regexp_replace(lower(title), '[^a-z0-9]', '', 'g') AS norm FROM paper_documents
       WHERE paper_key NOT LIKE 'journal:%'
         AND regexp_replace(lower(title), '[^a-z0-9]', '', 'g') IN (${slice.map(() => '?').join(',')})`,
      slice
    );
    for (const row of rows) {
      const article = byTitle.get(row.norm);
      if (article && !matches.has(article.doi)) matches.set(article.doi, row.paper_key);
    }
  }
  for (const [doi, paperKey] of matches) {
    const article = byDoi.get(doi);
    if (article) await linkArticleToPaper(article, paperKey);
  }
  return matches.size;
}

/** 把没有全文的文章写成 paper_documents 记录，进检索与知识库。 */
async function syncArticlesToPapers(dois: string[]) {
  let synced = 0;
  for (let i = 0; i < dois.length; i += 500) {
    const slice = dois.slice(i, i + 500);
    const rows = await all<JournalWatchArticleRow>(
      `SELECT * FROM journal_watch_articles WHERE fulltext = 0 AND doi IN (${slice.map(() => '?').join(',')})`,
      slice
    );
    if (!rows.length) continue;
    const keys: string[] = [];
    await withTransaction(async (db) => {
      for (const row of rows) {
        const journal = findJournal(row.journal_code);
        const paperKey = journalPaperKey(row.doi);
        const year = row.pub_date ? Number(row.pub_date.slice(0, 4)) : null;
        await db.prepare(
          `INSERT INTO paper_documents(
             paper_key, title, authors, file_path, pdf_path, original_path, file_hash, page_count, abstract, keywords,
             references_json, citations_json, algorithms_json, publish_year, journal, doi, pub_date, updated_at
           ) VALUES(?, ?, ?, '', '', ?, ?, 0, ?, ?, '[]', '[]', '[]', ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(paper_key) DO UPDATE SET
             title = excluded.title, authors = excluded.authors, original_path = excluded.original_path,
             abstract = excluded.abstract, keywords = excluded.keywords, publish_year = excluded.publish_year,
             journal = excluded.journal, doi = excluded.doi, pub_date = excluded.pub_date, updated_at = CURRENT_TIMESTAMP`
        ).run(
          paperKey, row.title, row.authors, row.url, `doi:${row.doi}`, row.abstract, row.keywords, year,
          journal?.name ?? null, row.doi, row.pub_date
        );
        await db.prepare('UPDATE journal_watch_articles SET paper_key = ? WHERE doi = ?').run(paperKey, row.doi);
        const paper = await db.prepare('SELECT * FROM paper_documents WHERE paper_key = ?').get<Record<string, unknown>>(paperKey);
        if (paper) await indexPaperDocumentInDb(db, paper as Parameters<typeof indexPaperDocumentInDb>[1]);
        keys.push(paperKey);
      }
    });
    await syncPaperDocumentsToCorpus(getDb(), { paperKeys: keys });
    synced += keys.length;
  }
  return synced;
}

export async function runJournalWatch(options: JournalWatchOptions = {}): Promise<JournalWatchSummary> {
  if (running) throw new Error('期刊追踪正在运行，请稍后再试。');
  running = true;
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await run(
    `INSERT INTO journal_watch_runs(id, trigger, status, started_at) VALUES(?, ?, 'running', ?)`,
    [runId, options.trigger || 'manual', startedAt]
  );
  const journals = options.journals?.length
    ? WATCHED_JOURNALS.filter((journal) => options.journals!.includes(journal.code))
    : [...WATCHED_JOURNALS];
  const summary: JournalWatchSummary = {
    sinceDate: '',
    journals: {},
    enriched: { ieee: 0, openalex: 0 },
    ieeeStatus: 'skipped',
    linked: 0,
    synced: 0,
    oaDownloaded: 0,
    oaFailed: 0,
    errors: []
  };
  const progress = (data: Record<string, unknown>) => Promise.resolve(options.onProgress?.(data)).catch(() => undefined);
  try {
    summary.sinceDate = await resolveSinceDate(options.backfillDays);
    const touched = new Set<string>();

    for (const journal of journals) {
      await progress({ phase: 'fetch', journal: journal.code });
      try {
        const articles = await fetchCrossrefArticles(journal, summary.sinceDate);
        const result = await upsertArticles(articles);
        result.touched.forEach((doi) => touched.add(doi));
        summary.journals[journal.code] = { fetched: articles.length, added: result.added };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.journals[journal.code] = { fetched: 0, added: 0, error: message };
        summary.errors.push(message);
      }
    }

    // 补摘要：IEEE 期刊先用 IEEE Xplore API，剩下的再用 OpenAlex
    const ieeeJournals = journals.filter((journal) => journal.publisher === 'IEEE');
    if (!process.env.IEEE_XPLORE_API_KEY?.trim()) {
      summary.ieeeStatus = 'no-key';
    } else {
      const missing = new Set((await articlesMissingAbstract(ieeeJournals)).map((row) => row.journal_code));
      summary.ieeeStatus = 'ok';
      for (const journal of ieeeJournals.filter((item) => missing.has(item.code))) {
        await progress({ phase: 'ieee', journal: journal.code });
        try {
          const enrichment = await fetchIeeeEnrichment(journal, localDate(-ENRICH_WINDOW_DAYS), localDate());
          summary.enriched.ieee += await applyEnrichment(enrichment, touched);
        } catch (error) {
          if (error instanceof IeeeKeyInactiveError) {
            summary.ieeeStatus = 'inactive';
            break;
          }
          summary.ieeeStatus = 'error';
          summary.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    const stillMissing = (await articlesMissingAbstract(journals)).map((row) => row.doi);
    if (stillMissing.length) {
      await progress({ phase: 'openalex', count: stillMissing.length });
      try {
        summary.enriched.openalex = await applyEnrichment(await fetchOpenAlexEnrichment(stillMissing), touched);
      } catch (error) {
        summary.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    await progress({ phase: 'link' });
    summary.linked = await linkExistingFulltext();
    await progress({ phase: 'sync', count: touched.size });
    summary.synced = await syncArticlesToPapers([...touched]);
    if (process.env.JOURNAL_WATCH_OA_DOWNLOAD !== '0') {
      const oa = await downloadOpenAccessFulltext(progress);
      summary.oaDownloaded = oa.downloaded;
      summary.oaFailed = oa.failed;
    }
    invalidateDbCaches();

    await run(
      `UPDATE journal_watch_runs SET status = 'done', finished_at = ?, summary_json = ? WHERE id = ?`,
      [new Date().toISOString(), JSON.stringify(summary), runId]
    );
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await run(
      `UPDATE journal_watch_runs SET status = 'error', finished_at = ?, summary_json = ?, error = ? WHERE id = ?`,
      [new Date().toISOString(), JSON.stringify(summary), message, runId]
    );
    throw error;
  } finally {
    running = false;
  }
}

/** PDF 存放目录：数据/论文/期刊追踪/<期刊>/，与其它论文一起参与导入与预览。 */
export async function fulltextDirectory(journalCode: string) {
  const { resolveDataSubdirs } = await import('../data-dirs');
  return path.join(resolveDataSubdirs().papers, '期刊追踪', journalCode);
}

export function fulltextFileName(doi: string) {
  return `${doi.replace(/[^a-z0-9._-]+/gi, '_')}.pdf`;
}

/** 上传或自动下载的全文 PDF：导入为论文，并替换该文章的摘要记录。 */
export async function attachFulltext(doi: string, source = 'upload') {
  const article = await get<JournalWatchArticleRow>('SELECT * FROM journal_watch_articles WHERE doi = ?', [doi]);
  if (!article) throw new Error(`未找到文章 ${doi}`);
  const dir = await fulltextDirectory(article.journal_code);
  const filePath = path.join(dir, fulltextFileName(doi));
  if (!fs.existsSync(filePath)) throw new Error('全文 PDF 不存在');

  const { ingestPaperDirectory } = await import('../papers');
  const previous = process.env.SKIP_EXISTING_PAPERS;
  process.env.SKIP_EXISTING_PAPERS = '1';
  try {
    await ingestPaperDirectory(dir);
  } finally {
    if (previous === undefined) delete process.env.SKIP_EXISTING_PAPERS;
    else process.env.SKIP_EXISTING_PAPERS = previous;
  }

  const resolved = path.resolve(filePath);
  const paper = await get<{ paper_key: string }>(
    `SELECT paper_key FROM paper_documents
     WHERE paper_key NOT LIKE 'journal:%' AND (pdf_path = ? OR file_path = ? OR original_path = ?)
     ORDER BY updated_at DESC LIMIT 1`,
    [resolved, resolved, resolved]
  );
  if (!paper) {
    // 同一份 PDF 之前已从别处导入过：按 DOI / 题目对上
    await linkExistingFulltext();
    const linked = await get<{ fulltext: number; paper_key: string }>(
      'SELECT fulltext, paper_key FROM journal_watch_articles WHERE doi = ?',
      [doi]
    );
    if (!linked?.fulltext) throw new Error('PDF 已保存，但没能解析入库，请检查文件是否完整。');
    await run('UPDATE journal_watch_articles SET pdf_source = ?, pdf_error = NULL WHERE doi = ?', [source, doi]);
    invalidateDbCaches();
    return { paperKey: linked.paper_key };
  }
  await linkArticleToPaper(article, paper.paper_key, true);
  await run('UPDATE journal_watch_articles SET pdf_source = ?, pdf_error = NULL WHERE doi = ?', [source, doi]);
  invalidateDbCaches();
  return { paperKey: paper.paper_key };
}

const IEEE_CODES = WATCHED_JOURNALS.filter((journal) => journal.publisher === 'IEEE').map((journal) => journal.code);

/**
 * 自动下载开放获取（OA）全文并入库。只下两类，都是作者/出版商公开授权的：
 *  - IEEE Xplore 上的开放获取文章（MPCE、JPES、PCMP 以及 Transactions 里付费开放的文章）；
 *  - OpenAlex 记录的开放仓储 PDF（arXiv 等，可能是预印本）。
 * 订阅文章不自动下载；Elsevier 的开放获取文章要等 Elsevier API 开通全文权限。
 * 每篇间隔几秒，每次最多 JOURNAL_WATCH_OA_MAX 篇，失败的最多重试 3 次。
 */
async function downloadOpenAccessFulltext(progress: (data: Record<string, unknown>) => Promise<unknown>) {
  const max = Math.max(0, Number(process.env.JOURNAL_WATCH_OA_MAX || 40) || 40);
  const rows = await all<JournalWatchArticleRow>(
    `SELECT * FROM journal_watch_articles
     WHERE fulltext = 0 AND pdf_attempts < 3 AND first_seen_at >= ?
       AND (
         (open_access = 1 AND journal_code IN (${IEEE_CODES.map(() => '?').join(',')}) AND alt_id ~ '^[0-9]+$')
         OR (oa_pdf_url IS NOT NULL AND oa_pdf_url <> '')
       )
     ORDER BY first_seen_at DESC LIMIT ?`,
    [new Date(Date.now() - ENRICH_WINDOW_DAYS * 86_400_000).toISOString(), ...IEEE_CODES, max * 3]
  );
  let downloaded = 0;
  let failed = 0;
  for (const row of rows) {
    if (downloaded + failed >= max) break;
    const ieee = row.open_access === 1 && IEEE_CODES.includes(row.journal_code) && /^\d+$/.test(row.alt_id || '');
    const repository = isAutoDownloadableUrl(row.oa_pdf_url);
    if (!ieee && !repository) continue;
    await progress({ phase: 'oa-pdf', journal: row.journal_code, done: downloaded });
    try {
      const bytes = ieee ? await downloadIeeeOpenAccessPdf(row.alt_id!) : await downloadRepositoryPdf(row.oa_pdf_url!);
      const dir = await fulltextDirectory(row.journal_code);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fulltextFileName(row.doi)), bytes);
      const source = ieee ? 'ieee-oa' : /arxiv\.org/i.test(row.oa_pdf_url || '') ? 'arxiv' : 'oa-repository';
      await attachFulltext(row.doi, source);
      downloaded += 1;
    } catch (error) {
      failed += 1;
      await run(
        'UPDATE journal_watch_articles SET pdf_attempts = pdf_attempts + 1, pdf_error = ? WHERE doi = ?',
        [(error instanceof Error ? error.message : String(error)).slice(0, 300), row.doi]
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  return { downloaded, failed };
}
