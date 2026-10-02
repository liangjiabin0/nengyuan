import { randomUUID } from 'node:crypto';
import { Pool, types, type PoolClient, type QueryResult } from 'pg';
import { hashPassword } from '../auth/password';
import { DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_USERNAME } from '../auth/types';
import { sanitizePersistedAgentSteps } from '../opencode/persisted-agent-steps';
import type { RuntimeAgentStep } from '../opencode/types';
import { POSTGRES_SCHEMA_SQL } from './schema';
import { toPgParams } from './sql-translate';

types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));
types.setTypeParser(types.builtins.TIMESTAMP, (value) => value);
types.setTypeParser(types.builtins.TIMESTAMPTZ, (value) => value);

export type SqlClient = Pool | PoolClient;

export type RunResult = {
  changes: number;
  lastInsertRowid: number | string;
};

export class PgStatement {
  constructor(
    private readonly db: PgDatabase,
    private readonly sql: string,
    private plucked = false
  ) {}

  pluck(_column?: boolean) {
    this.plucked = true;
    return this;
  }

  async get<T = Record<string, unknown>>(...params: unknown[]): Promise<T | undefined> {
    const rows = await this.db.query<T>(this.sql, flattenParams(params), { limit: 1 });
    const row = rows[0];
    if (!row) return undefined;
    if (this.plucked) return firstValue(row) as T;
    return row;
  }

  async all<T = Record<string, unknown>>(...params: unknown[]): Promise<T[]> {
    const rows = await this.db.query<T>(this.sql, flattenParams(params));
    if (this.plucked) return rows.map((row) => firstValue(row as Record<string, unknown>) as T);
    return rows;
  }

  async run(...params: unknown[]): Promise<RunResult> {
    return this.db.execute(this.sql, flattenParams(params));
  }
}

export class PgDatabase {
  constructor(
    private readonly client: SqlClient,
    private readonly bootstrapping = false
  ) {}

  prepare(sql: string) {
    return new PgStatement(this, sql);
  }

  private async ready() {
    if (!this.bootstrapping) await ensureDb();
  }

  async exec(sql: string) {
    await this.ready();
    const chunks = splitSqlStatements(sql);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      await this.client.query(chunk);
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
    options?: { limit?: number }
  ): Promise<T[]> {
    await this.ready();
    let text = sql;
    if (options?.limit && !/\bLIMIT\b/i.test(text)) {
      text = `${text} LIMIT ${Number(options.limit)}`;
    }
    const mapped = toPgParams(text, params);
    const result = await this.client.query(mapped.text, mapped.values);
    return result.rows as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<RunResult> {
    await this.ready();
    const mapped = toPgParams(sql, params);
    const result = await this.client.query(mapped.text, mapped.values);
    return {
      changes: result.rowCount ?? 0,
      lastInsertRowid: readInsertedId(result)
    };
  }

  async transaction<T>(fn: (db: PgDatabase) => Promise<T> | T): Promise<T> {
    await this.ready();
    if (isPoolClient(this.client)) {
      return fn(this);
    }
    const conn = await (this.client as Pool).connect();
    const nested = new PgDatabase(conn, true);
    try {
      await conn.query('BEGIN');
      const value = await fn(nested);
      await conn.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await conn.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw error;
    } finally {
      conn.release();
    }
  }

  pragma(_sql: string) {
    return undefined;
  }

  close() {
    return undefined;
  }
}

export type Database = PgDatabase;

let pool: Pool | null = null;
let conversationRunLockPool: Pool | null = null;
let ready: Promise<PgDatabase> | null = null;
let instance: PgDatabase | null = null;

export function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL
    || `postgres://ai4es:${encodeURIComponent(process.env.PGPASSWORD || 'ai4es_local')}@127.0.0.1:5432/ai4es`
  );
}

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      max: Number(process.env.PG_POOL_MAX || 12) || 12,
      idleTimeoutMillis: 30_000
    });
  }
  return pool;
}

/**
 * Conversation runs hold a session advisory lock for their full lifetime.
 * Keep those long-lived sessions out of the general query pool so active
 * generations cannot starve ordinary API/database work.
 */
export function getConversationRunLockPool() {
  if (!conversationRunLockPool) {
    conversationRunLockPool = new Pool({
      connectionString: getDatabaseUrl(),
      max: Math.max(1, Number(process.env.PG_RUN_LOCK_POOL_MAX || 64) || 64),
      idleTimeoutMillis: 30_000
    });
  }
  return conversationRunLockPool;
}

export function getDb(): PgDatabase {
  if (!instance) instance = new PgDatabase(getPool());
  void ensureDb();
  return instance;
}

export async function ensureDb(): Promise<PgDatabase> {
  if (!ready) {
    ready = (async () => {
      const current = new PgDatabase(getPool(), true);
      await applySchema(current);
      await seedDefaultAdminAndOwnership(current);
      if (!instance) instance = new PgDatabase(getPool());
      return instance;
    })().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

export async function resetDb() {
  ready = null;
  instance = null;
  if (conversationRunLockPool) {
    await conversationRunLockPool.end();
    conversationRunLockPool = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
}

async function applySchema(db: PgDatabase) {
  await db.exec(POSTGRES_SCHEMA_SQL);
  await db.exec(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS skill_ids_json TEXT`);
  await db.exec(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS thunder INTEGER NOT NULL DEFAULT 0`);
  await db.exec(`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS chat_model TEXT NOT NULL DEFAULT 'arc'`);
  await db.exec(`UPDATE chat_conversations SET chat_model = 'thunder' WHERE COALESCE(thunder, 0) = 1 AND (chat_model IS NULL OR chat_model = '' OR chat_model = 'arc')`);
  await db.execute(
    `INSERT INTO schema_migrations(id) VALUES(?) ON CONFLICT (id) DO NOTHING`,
    ['0001-postgres-core']
  );
  await ensureSelfLearningSearch(db);
  await sanitizePersistedAgentStepPayloads(db);
  const { migrateWhitepaperToBook } = await import('../corpus/migrate-whitepaper-to-book');
  await migrateWhitepaperToBook(db);
}

async function ensureSelfLearningSearch(db: PgDatabase) {
  await db.exec(`ALTER TABLE self_learning_memories ADD COLUMN IF NOT EXISTS pinned INTEGER NOT NULL DEFAULT 0`);
  await db.exec(`ALTER TABLE self_learning_memories ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT ''`);
  await db.exec(`ALTER TABLE self_learning_memories ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(search_text, ''))) STORED`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_self_learning_search ON self_learning_memories USING gin (search_tsv)`);
  const { learningSearchDocument } = await import('../self-learning-search');
  const rows = await db.prepare(
    `SELECT id, domain_label, instruction, applicability, keywords_json
     FROM self_learning_memories
     WHERE COALESCE(search_text, '') = ''`
  ).all<{
    id: string;
    domain_label: string;
    instruction: string;
    applicability: string;
    keywords_json: string;
  }>();
  for (const row of rows) {
    let keywords: string[] = [];
    try {
      const parsed = JSON.parse(row.keywords_json || '[]') as unknown;
      keywords = Array.isArray(parsed) ? parsed.map((item) => String(item || '')) : [];
    } catch {
      keywords = [];
    }
    const searchText = learningSearchDocument({
      instruction: row.instruction,
      applicability: row.applicability,
      domainLabel: row.domain_label,
      keywords
    });
    if (!searchText) continue;
    await db.prepare(
      `UPDATE self_learning_memories SET search_text = ? WHERE id = ? AND COALESCE(search_text, '') = ''`
    ).run(searchText, row.id);
  }
}

async function sanitizePersistedAgentStepPayloads(db: PgDatabase) {
  // Normalize legacy payload shapes while retaining every valid runtime step.
  const migrationId = '0004-sanitize-chat-agent-step-envelopes';
  const applied = await db.prepare('SELECT 1 AS ok FROM schema_migrations WHERE id = ?').get<{ ok: number }>(migrationId);
  if (applied) return;

  const rows = await db.prepare(
    `SELECT id, agent_steps_json
     FROM chat_messages
     WHERE agent_steps_json IS NOT NULL`
  ).all<{ id: string; agent_steps_json: string }>();

  await db.transaction(async (transaction) => {
    const update = transaction.prepare('UPDATE chat_messages SET agent_steps_json = ? WHERE id = ?');
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.agent_steps_json);
      } catch {
        await update.run(null, row.id);
        continue;
      }

      if (Array.isArray(parsed)) {
        const steps = sanitizePersistedAgentSteps(parsed as RuntimeAgentStep[]);
        await update.run(steps.length ? JSON.stringify(steps) : null, row.id);
        continue;
      }
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { steps?: unknown }).steps)) {
        const payload = parsed as { steps: RuntimeAgentStep[] } & Record<string, unknown>;
        const steps = sanitizePersistedAgentSteps(payload.steps);
        await update.run(JSON.stringify({ ...payload, steps }), row.id);
        continue;
      }
      await update.run(null, row.id);
    }
    await transaction.prepare(
      'INSERT INTO schema_migrations(id) VALUES(?) ON CONFLICT (id) DO NOTHING'
    ).run(migrationId);
  });
}

async function seedDefaultAdminAndOwnership(db: PgDatabase) {
  const existing = await db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get<{ id: string }>(
    DEFAULT_ADMIN_USERNAME
  );
  let adminId = existing?.id;
  if (!adminId) {
    if (DEFAULT_ADMIN_PASSWORD.length < 12) {
      throw new Error('首次初始化必须设置至少12位的 DEFAULT_ADMIN_PASSWORD。');
    }
    adminId = randomUUID();
    await db.prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(adminId, DEFAULT_ADMIN_USERNAME, hashPassword(DEFAULT_ADMIN_PASSWORD));
  }
  const needsChat = await db.prepare(
    "SELECT 1 AS ok FROM chat_conversations WHERE user_id IS NULL OR user_id = '' LIMIT 1"
  ).get();
  if (needsChat) {
    await db.prepare("UPDATE chat_conversations SET user_id = ? WHERE user_id IS NULL OR user_id = ''").run(adminId);
  }
  const needsPatent = await db.prepare(
    "SELECT 1 AS ok FROM patent_projects WHERE user_id IS NULL OR user_id = '' LIMIT 1"
  ).get();
  if (needsPatent) {
    await db.prepare("UPDATE patent_projects SET user_id = ? WHERE user_id IS NULL OR user_id = ''").run(adminId);
  }
  const needsGuide = await db.prepare(
    "SELECT 1 AS ok FROM grid_guide_projects WHERE user_id IS NULL OR user_id = '' LIMIT 1"
  ).get();
  if (needsGuide) {
    await db.prepare("UPDATE grid_guide_projects SET user_id = ? WHERE user_id IS NULL OR user_id = ''").run(adminId);
  }
}

function flattenParams(params: unknown[]) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0] as unknown[];
  return params;
}

function firstValue(row: Record<string, unknown>) {
  const values = Object.values(row);
  return values[0];
}

function readInsertedId(result: QueryResult) {
  const row = result.rows[0] as { id?: number | string } | undefined;
  if (row?.id != null) return row.id;
  return 0;
}

function isPoolClient(client: SqlClient): client is PoolClient {
  return typeof (client as PoolClient).release === 'function';
}

function splitSqlStatements(sql: string) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('--'));
}
