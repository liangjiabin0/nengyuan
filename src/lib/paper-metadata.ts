import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db';
import { authorsFieldLooksValid, parseAuthorsFromRecord } from './paper-authors';
import { upsertEdgeInDb, upsertEntityInDb } from './normalize';

type MetadataItem = {
  fileName?: string;
  title?: string;
  authors?: string;
  journal?: string;
  doi?: string;
  publishYear?: string | number;
  pubDate?: string;
};

let checked = false;
let lastResult = { available: false, items: 0, matched: 0, updated: 0, authorsFixed: 0 };

function normalizeTitle(value: string) {
  return String(value || '')
    .replace(/_[^_]+$/u, '')
    .replace(/\s+/g, '')
    .replace(/[_\-—–:："'“”]/g, '')
    .toLowerCase();
}

async function rebuildAuthoredBy(db: ReturnType<typeof getDb>, paperKey: string, authors: string) {
  await db.prepare(`DELETE FROM edges WHERE source_key = ? AND relation = 'authored_by'`).run(paperKey);
  for (const author of parseAuthorsFromRecord(authors)) {
    const personKey = await upsertEntityInDb(db, 'person', author);
    if (personKey) await upsertEdgeInDb(db, paperKey, personKey, 'authored_by', 5);
  }
}

export async function ensurePaperMetadataBackfilled(force = false) {
  if (checked && !force) return lastResult;
  const metadataPath = path.join(process.cwd(), 'outputs', 'spreadsheet-work', 'paper-metadata-cqvip.json');
  if (!fs.existsSync(metadataPath)) {
    lastResult = { available: false, items: 0, matched: 0, updated: 0, authorsFixed: 0 };
    checked = true;
    return lastResult;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { items?: MetadataItem[] };
    const items = payload.items || [];
    const byTitle = new Map<string, MetadataItem>();
    const byFile = new Map<string, MetadataItem>();
    for (const item of items) {
      if (item.title) byTitle.set(normalizeTitle(item.title), item);
      if (item.fileName) {
        const base = path.basename(item.fileName).toLowerCase();
        byFile.set(base, item);
        byFile.set(base.replace(/\.caj$/i, '.pdf'), item);
        byFile.set(base.replace(/\.pdf$/i, '.caj'), item);
      }
    }

    const db = getDb();
    const papers = await db.prepare(
      `SELECT paper_key, title, authors, file_path, pdf_path, publish_year, journal, doi, pub_date
       FROM paper_documents WHERE paper_key NOT LIKE 'patent:%' AND paper_key NOT LIKE 'book:%' AND paper_key NOT LIKE 'whitepaper:%'`
    ).all<{
      paper_key: string;
      title: string;
      authors?: string;
      file_path: string;
      pdf_path: string;
      publish_year?: number;
      journal?: string;
      doi?: string;
      pub_date?: string;
    }>();
    const update = db.prepare(
      `UPDATE paper_documents
       SET publish_year=?, journal=?, doi=?, pub_date=?, authors=?
       WHERE paper_key=?`
    );
    let matched = 0;
    let updated = 0;
    let authorsFixed = 0;
    const authorRebuildQueue: Array<{ paperKey: string; authors: string }> = [];
    await db.transaction(async () => {
      for (const paper of papers) {
        const base = path.basename(paper.file_path || paper.pdf_path || '').toLowerCase();
        const item = byFile.get(base) || byTitle.get(normalizeTitle(paper.title));
        if (!item) continue;
        matched += 1;
        const year = Number(item.publishYear);
        const publishYear = Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
        const metaAuthors = String(item.authors || '').trim();
        const currentAuthors = String(paper.authors || '').trim();
        const shouldReplaceAuthors = Boolean(metaAuthors)
          && authorsFieldLooksValid(metaAuthors)
          && (!currentAuthors || !authorsFieldLooksValid(currentAuthors));
        const nextAuthors = shouldReplaceAuthors ? metaAuthors : currentAuthors;
        const changed =
          publishYear !== (paper.publish_year || null)
          || (item.journal || null) !== (paper.journal || null)
          || (item.doi || null) !== (paper.doi || null)
          || (item.pubDate || null) !== (paper.pub_date || null)
          || nextAuthors !== currentAuthors;
        if (!changed) continue;
        await update.run(
          publishYear,
          item.journal || null,
          item.doi || null,
          item.pubDate || null,
          nextAuthors || '',
          paper.paper_key
        );
        updated += 1;
        if (shouldReplaceAuthors && nextAuthors !== currentAuthors) {
          authorRebuildQueue.push({ paperKey: paper.paper_key, authors: nextAuthors });
          authorsFixed += 1;
        }
      }
    });
    // 作者边重建放在字段更新之后，避免长事务占用锁。
    for (const item of authorRebuildQueue) {
      try {
        await rebuildAuthoredBy(db, item.paperKey, item.authors);
      } catch {
        // 边重建失败不影响年份/作者字段本身的可用性。
      }
    }
    lastResult = { available: true, items: items.length, matched, updated, authorsFixed };
    checked = true;
    return lastResult;
  } catch (error) {
    checked = false;
    throw error;
  }
}
