import fs from 'node:fs';
import path from 'node:path';
import type { PgDatabase } from '../db/pg-database';
import { getParsedDocumentsDir } from '../fund-markdown';
import { getCorpusRoot } from './schema';

const MIGRATION_ID = '0002-whitepaper-to-book';

async function tableExists(db: PgDatabase, table: string) {
  const row = await db
    .prepare(`SELECT to_regclass(?) AS name`)
    .get<{ name: string | null }>(`public.${table}`);
  return Boolean(row?.name);
}

async function replacePrefix(db: PgDatabase, table: string, column: string) {
  if (!(await tableExists(db, table))) return;
  await db
    .prepare(
      `UPDATE ${table}
       SET ${column} = replace(${column}, 'whitepaper:', 'book:')
       WHERE ${column} LIKE 'whitepaper:%'`
    )
    .run();
}

function retireDirectory(fromDir: string) {
  if (!fs.existsSync(fromDir)) return;
  const retired = `${fromDir}.pre-book`;
  if (fs.existsSync(retired)) fs.rmSync(retired, { recursive: true, force: true });
  fs.renameSync(fromDir, retired);
  return retired;
}

export async function migrateWhitepaperToBook(db: PgDatabase) {
  const applied = await db
    .prepare('SELECT id FROM schema_migrations WHERE id = ?')
    .get<{ id: string }>(MIGRATION_ID);
  if (applied) return { skipped: true as const };

  const pending = await db
    .prepare("SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key LIKE 'whitepaper:%'")
    .get<{ c: number }>();
  const hasLegacyKeys = Number(pending?.c || 0) > 0;

  await replacePrefix(db, 'paper_documents', 'paper_key');
  await replacePrefix(db, 'paper_chunks', 'paper_key');
  await replacePrefix(db, 'paper_chunks', 'chunk_key');
  await replacePrefix(db, 'paper_chunks', 'parent_key');
  await replacePrefix(db, 'search_records', 'source_key');
  await replacePrefix(db, 'search_records', 'record_id');
  if (await tableExists(db, 'search_records')) {
    await db
      .prepare(
        `UPDATE search_records
         SET fields_json = replace(fields_json, 'whitepaper:', 'book:')
         WHERE fields_json LIKE '%whitepaper:%'`
      )
      .run();
  }
  await replacePrefix(db, 'entities', 'entity_key');
  await replacePrefix(db, 'edges', 'source_key');
  await replacePrefix(db, 'edges', 'target_key');
  await replacePrefix(db, 'entity_aliases', 'entity_key');
  await replacePrefix(db, 'entity_mentions', 'entity_key');
  await replacePrefix(db, 'entity_mentions', 'record_id');
  await replacePrefix(db, 'merge_candidates', 'source_key');
  await replacePrefix(db, 'merge_candidates', 'target_key');
  if (await tableExists(db, 'corpus_file_comments')) {
    await replacePrefix(db, 'corpus_file_comments', 'record_key');
    await db
      .prepare(
        `UPDATE corpus_file_comments
         SET relative_path = replace(relative_path, 'whitepapers/', 'books/'),
             domain = CASE WHEN domain = 'whitepapers' THEN 'books' ELSE domain END
         WHERE relative_path LIKE 'whitepapers/%' OR domain = 'whitepapers'`
      )
      .run();
  }

  const corpusRoot = getCorpusRoot();
  const retiredCorpus = retireDirectory(path.join(corpusRoot, 'whitepapers'));
  const retiredParsed = retireDirectory(getParsedDocumentsDir('books').replace(/[\\/]books$/, `${path.sep}whitepapers`));
  fs.mkdirSync(path.join(corpusRoot, 'books'), { recursive: true });
  fs.mkdirSync(getParsedDocumentsDir('books'), { recursive: true });

  if (hasLegacyKeys) {
    try {
      const { syncPaperDocumentsToCorpus } = await import('./export');
      await syncPaperDocumentsToCorpus(db, { keyPrefix: 'book:' });
    } catch (error) {
      console.warn('[migrate-whitepaper-to-book] corpus resync failed', error);
    }
  }

  if (retiredCorpus && fs.existsSync(retiredCorpus)) {
    fs.rmSync(retiredCorpus, { recursive: true, force: true });
  }
  if (retiredParsed && fs.existsSync(retiredParsed)) {
    fs.rmSync(retiredParsed, { recursive: true, force: true });
  }

  await db
    .prepare(`INSERT INTO schema_migrations(id) VALUES(?) ON CONFLICT (id) DO NOTHING`)
    .run(MIGRATION_ID);

  return { skipped: false as const, rewritten: hasLegacyKeys };
}
