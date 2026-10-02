import { getBundleRoot } from './bundle-store';
import { readDbSummary, writeDbSummary, type DbSummaryPayload } from './db-summary';
import {
  ensureDb,
  getDb,
  PgDatabase,
  resetDb,
  type Database,
  type RunResult
} from './db/pg-database';
import { getCached, invalidateQueryCache } from './query-cache';

export { ensureDb, getDb, resetDb, type Database, type RunResult };
export type { PgDatabase };

/** @deprecated 文件库自动持久化，保留空实现以兼容旧调用 */
export function scheduleSaveDb() {}

/** @deprecated 文件库自动持久化，保留空实现以兼容旧调用 */
export async function flushSaveDb() {}

/** @deprecated 文件库自动持久化，保留空实现以兼容旧调用 */
export function saveDb(_database?: Database) {}

export async function withTransaction<T>(fn: (database: Database) => Promise<T> | T, _persist = false) {
  return getDb().transaction(fn);
}

export async function run(sql: string, params: unknown[] = [], _persist = false): Promise<RunResult> {
  return getDb().prepare(sql).run(...params);
}

export async function all<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return getDb().prepare(sql).all<T>(...params);
}

export async function get<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return getDb().prepare(sql).get<T>(...params);
}

export async function getStatsUncached() {
  const row = await get<Record<string, number>>(
    `SELECT
      (SELECT COUNT(*) FROM source_files) AS files,
      (SELECT COUNT(*) FROM raw_records) AS "rawRecords",
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM outputs) AS outputs,
      (SELECT COUNT(*) FROM entities) AS entities,
      (SELECT COUNT(*) FROM edges) AS edges`
  );
  return {
    files: Number(row?.files || 0),
    rawRecords: Number(row?.rawRecords || 0),
    projects: Number(row?.projects || 0),
    outputs: Number(row?.outputs || 0),
    entities: Number(row?.entities || 0),
    edges: Number(row?.edges || 0)
  };
}

export async function getStats() {
  const summary = readDbSummary();
  if (summary?.stats) return summary.stats;
  return getCached('stats:summary', 60_000, () => getStatsUncached());
}

export async function persistDbSummary(input?: {
  stats?: DbSummaryPayload['stats'];
  indexStats?: DbSummaryPayload['indexStats'];
  papers?: number;
  patents?: number;
  books?: number;
  whitepapers?: number;
  mentors?: number;
  disk?: DbSummaryPayload['disk'];
  bundleActive?: boolean;
  includeSlowCounts?: boolean;
}): Promise<DbSummaryPayload> {
  const { getIndexStatsUncached } = await import('./search-index');
  const previous = readDbSummary();
  const stats = input?.stats ?? (previous?.stats || await getStatsUncached());
  const indexStats =
    input?.indexStats ?? await getIndexStatsUncached(Boolean(input?.includeSlowCounts));
  const database = getDb();
  const papers =
    input?.papers ??
    previous?.papers ??
    Number(
      (
        await database
          .prepare(
            "SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key NOT LIKE 'patent:%' AND paper_key NOT LIKE 'book:%' AND paper_key NOT LIKE 'whitepaper:%'"
          )
          .get<{ c: number }>()
      )?.c || 0
    );
  const patents =
    input?.patents ??
    previous?.patents ??
    Number(
      (await database.prepare("SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key LIKE 'patent:%'").get<{ c: number }>())
        ?.c || 0
    );
  const books =
    input?.books ??
    previous?.books ??
    previous?.whitepapers ??
    Number(
      (
        await database
          .prepare(
            "SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key LIKE 'book:%' OR paper_key LIKE 'whitepaper:%'"
          )
          .get<{ c: number }>()
      )?.c || 0
    );
  const mentors =
    input?.mentors ??
    previous?.mentors ??
    Number((await database.prepare('SELECT COUNT(*) AS c FROM mentor_profiles').get<{ c: number }>())?.c || 0);

  const disk = input?.disk ?? previous?.disk ?? {
    paperPdf: 0,
    paperCaj: 0,
    patentMd: 0,
    bookPdf: previous?.disk?.bookPdf ?? previous?.disk?.whitepaperPdf ?? 0,
    fundTables: 0,
    mentorMd: 0
  };

  const payload: DbSummaryPayload = {
    updatedAt: new Date().toISOString(),
    stats,
    indexStats,
    papers,
    patents,
    books,
    mentors,
    disk,
    bundleActive: input?.bundleActive ?? Boolean(getBundleRoot())
  };
  writeDbSummary(payload);
  invalidateDbCaches();
  return payload;
}

export function invalidateDbCaches() {
  invalidateQueryCache('stats:');
  invalidateQueryCache('index:');
  invalidateQueryCache('dashboard:');
}

export async function listTables() {
  return all<{ name: string }>(
    `SELECT table_name AS name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
}

export async function getColumns(table: string) {
  return all<{ name: string; type: string }>(
    `SELECT column_name AS name, data_type AS type
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ?
     ORDER BY ordinal_position`,
    [table]
  );
}
