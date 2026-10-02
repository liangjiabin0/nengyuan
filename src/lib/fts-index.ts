import type { Database } from './db';
import { all, getDb } from './db';
import { tokenizeText } from './text';

export function ensureFtsIndex(_db: Database = getDb()) {
  return undefined;
}

export async function clearFtsIndex(_db: Database = getDb()) {
  return undefined;
}

export async function upsertFtsRecord(
  _recordId: string,
  _title: string,
  _body: string,
  _db: Database = getDb()
) {
  return undefined;
}

export async function syncFtsFromSearchRecords(_db: Database = getDb()) {
  return undefined;
}

function buildFtsMatchQuery(query: string) {
  const terms = [...new Set(tokenizeText(query).filter((term) => term.length >= 2))].slice(0, 14);
  if (!terms.length) return '';
  return terms.join(' | ');
}

export async function searchFts(query: string, limit = 40): Promise<Array<{ recordId: string; rank: number }>> {
  const match = buildFtsMatchQuery(query);
  const needle = query.trim();
  if (!match && needle.length < 2) return [];

  try {
    const rows = await all<{ recordId: string; rank: number }>(
      `SELECT record_id AS "recordId",
              GREATEST(
                COALESCE(ts_rank(search_tsv, to_tsquery('simple', ?)), 0),
                CASE WHEN title ILIKE ? THEN 0.8 ELSE 0 END
              ) AS rank
       FROM search_records
       WHERE (? = '' OR search_tsv @@ to_tsquery('simple', ?))
          OR (? <> '' AND title ILIKE ?)
       ORDER BY rank DESC
       LIMIT ?`,
      [match || 'x', `%${needle}%`, match, match || 'x', needle, `%${needle}%`, limit]
    );
    return rows.map((row) => ({ recordId: row.recordId, rank: Number(row.rank || 0) }));
  } catch {
    if (!needle) return [];
    const rows = await all<{ recordId: string }>(
      `SELECT record_id AS "recordId" FROM search_records WHERE title ILIKE ? LIMIT ?`,
      [`%${needle}%`, limit]
    );
    return rows.map((row, index) => ({ recordId: row.recordId, rank: 1 - index / 1000 }));
  }
}

export async function hasAttachmentFts() {
  const row = await all<{ ok: string }>(
    `SELECT '1' AS ok FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'chat_attachment_chunks' AND column_name = 'search_tsv'
     LIMIT 1`
  );
  return row.length > 0;
}
