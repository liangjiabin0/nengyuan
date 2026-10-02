import fs from 'node:fs';
import path from 'node:path';
import { getDb, withTransaction, persistDbSummary } from '../src/lib/db';

type MetaItem = {
  fileName?: string;
  title?: string;
  authors?: string;
  journal?: string;
  doi?: string;
  publishYear?: string | number;
  pubDate?: string;
  volume?: string | number;
  issue?: string | number;
  pages?: string;
  abstract?: string;
  keywords?: string;
};

function normalizeTitle(value: string) {
  return value.replace(/\s+/g, '').replace(/[_\-—–]/g, '').toLowerCase();
}

async function main() {
  const metaPath =
    process.argv[2] ||
    path.join(process.cwd(), 'outputs', 'spreadsheet-work', 'paper-metadata-cqvip.json');
  if (!fs.existsSync(metaPath)) {
    console.error('找不到元数据文件:', metaPath);
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { items?: MetaItem[] };
  const items = payload.items || [];
  const byTitle = new Map<string, MetaItem>();
  const byFile = new Map<string, MetaItem>();
  for (const item of items) {
    if (item.title) byTitle.set(normalizeTitle(item.title), item);
    if (item.fileName) byFile.set(path.basename(item.fileName).toLowerCase(), item);
  }

  let matched = 0;
  let updated = 0;

  await withTransaction(async (db) => {
    const papers = db
      .prepare('SELECT paper_key, title, authors, abstract, keywords, file_path, pdf_path, publish_year, journal, doi, pub_date FROM paper_documents')
      .all() as Array<{
      paper_key: string;
      title: string;
      authors?: string;
      abstract?: string;
      keywords?: string;
      file_path: string;
      pdf_path: string;
      publish_year?: number;
      journal?: string;
      doi?: string;
      pub_date?: string;
    }>;

    const update = db.prepare(
      `UPDATE paper_documents
       SET title=?, authors=?, abstract=?, keywords=?, publish_year=?, journal=?, doi=?, pub_date=?, updated_at=CURRENT_TIMESTAMP
       WHERE paper_key=?`
    );

    for (const paper of papers) {
      if (String(paper.paper_key).startsWith('patent:')) continue;
      const base = path.basename(paper.file_path || paper.pdf_path || '').toLowerCase();
      const meta =
        byFile.get(base) ||
        byFile.get(base.replace(/\.pdf$/i, '.caj')) ||
        byTitle.get(normalizeTitle(paper.title));
      if (!meta) continue;
      matched += 1;
      const nextTitle = meta.title || paper.title;
      const nextAuthors = meta.authors || paper.authors || '';
      const nextAbstract = meta.abstract || paper.abstract || '';
      const nextKeywords = meta.keywords || paper.keywords || '';
      const year = Number(meta.publishYear);
      const nextPublishYear = Number.isInteger(year) ? year : paper.publish_year || null;
      const nextJournal = meta.journal || paper.journal || '';
      const nextDoi = meta.doi || paper.doi || '';
      const nextPubDate = meta.pubDate || paper.pub_date || '';
      if (
        nextTitle !== paper.title ||
        nextAuthors !== (paper.authors || '') ||
        nextAbstract !== (paper.abstract || '') ||
        nextKeywords !== (paper.keywords || '') ||
        nextPublishYear !== (paper.publish_year || null) ||
        nextJournal !== (paper.journal || '') ||
        nextDoi !== (paper.doi || '') ||
        nextPubDate !== (paper.pub_date || '')
      ) {
        update.run(nextTitle, nextAuthors, nextAbstract, nextKeywords, nextPublishYear, nextJournal, nextDoi, nextPubDate, paper.paper_key);
        updated += 1;
      }
    }
  }, true);

  await persistDbSummary({ includeSlowCounts: true });
  console.log(JSON.stringify({ metaPath, items: items.length, matched, updated }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
