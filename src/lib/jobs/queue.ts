import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import {
  EXCLUSIVE_CLAIM_JOB_TYPES,
  SERIAL_JOB_TYPES,
  type BackgroundJob,
  type JobStatus,
  type JobType
} from './types';

type JobRow = {
  id: string;
  type: string;
  status: string;
  payload_json: string;
  progress_json: string | null;
  result_json: string | null;
  error: string | null;
  attempt: number;
  max_attempts: number;
  available_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
};

const STALE_MS = Number(process.env.AI4ES_JOB_STALE_MS || 30 * 60 * 1000);
const SCHEME_RESEARCH_STALE_MS = Number(process.env.AI4ES_SCHEME_RESEARCH_STALE_MS || 75 * 60 * 1000);
const GRID_GUIDE_STALE_MS = Number(process.env.AI4ES_GRID_GUIDE_STALE_MS || 8 * 60 * 60 * 1000);
const DEFAULT_MAX_ATTEMPTS = Math.max(1, Number(process.env.AI4ES_JOB_MAX_ATTEMPTS || 3) || 3);
const RETRY_BASE_MS = Math.max(1_000, Number(process.env.AI4ES_JOB_RETRY_BASE_MS || 5_000) || 5_000);

async function ensureJobsTable() {
  const db = getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS background_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      progress_json TEXT,
      result_json TEXT,
      error TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      available_at TEXT,
      locked_by TEXT,
      locked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_background_jobs_status_type ON background_jobs(status, type);
    ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;
    ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS available_at TEXT;
  `);
}

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToJob(row: JobRow): BackgroundJob {
  return {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    progress: parseJson<Record<string, unknown> | null>(row.progress_json, null),
    result: parseJson<unknown>(row.result_json, null),
    error: row.error,
    attempt: Number(row.attempt || 0),
    maxAttempts: Math.max(1, Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS)),
    availableAt: row.available_at,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function isJobQueueEnabled() {
  return process.env.AI4ES_USE_JOB_QUEUE === '1';
}

export async function enqueueJob(type: JobType, payload: Record<string, unknown> = {}): Promise<BackgroundJob> {
  await ensureJobsTable();
  const db = getDb();

  if (SERIAL_JOB_TYPES.has(type)) {
    const existing = await db
      .prepare(
        `SELECT * FROM background_jobs
         WHERE type = ? AND status IN ('queued', 'running')
         ORDER BY created_at ASC LIMIT 1`
      )
      .get<JobRow>(type);
    if (existing) return rowToJob(existing);
  }

  if (type === 'ppt-voice-build') {
    const projectId = String(payload.projectId || '').trim();
    if (projectId) {
      const existing = await db
        .prepare(
          `SELECT * FROM background_jobs
           WHERE type = 'ppt-voice-build'
             AND status IN ('queued', 'running')
             AND position(? in payload_json) > 0
           ORDER BY created_at ASC LIMIT 1`
        )
        .get<JobRow>(`"projectId":"${projectId}"`);
      if (existing) return rowToJob(existing);
    }
  }

  if (type === 'scheme-research') {
    const sessionId = String(payload.sessionId || '').trim();
    if (sessionId) {
      const existing = await db
        .prepare(
          `SELECT * FROM background_jobs
           WHERE type = 'scheme-research'
             AND status IN ('queued', 'running')
             AND position(? in payload_json) > 0
           ORDER BY created_at ASC LIMIT 1`
        )
        .get<JobRow>(`"sessionId":"${sessionId}"`);
      if (existing) return rowToJob(existing);
    }
  }

  if (type === 'mgplan-solve' || type === 'tdmg-solve' || type === 'dispatch-run' || type === 'loss-calc' || type === 'modelica-sim' || type === 'forecast-run') {
    const ideaId = String(payload.ideaId || '').trim();
    if (ideaId) {
      const existing = await db
        .prepare(
          `SELECT * FROM background_jobs
           WHERE type = ?
             AND status IN ('queued', 'running')
             AND position(? in payload_json) > 0
           ORDER BY created_at ASC LIMIT 1`
        )
        .get<JobRow>(type, `"ideaId":"${ideaId}"`);
      if (existing) return rowToJob(existing);
    }
  }

  if (type === 'grid-guide-task') {
    const projectId = String(payload.projectId || '').trim();
    if (projectId) {
      const existing = await db
        .prepare(
          `SELECT * FROM background_jobs
           WHERE type = 'grid-guide-task'
             AND status IN ('queued', 'running')
             AND position(? in payload_json) > 0
           ORDER BY created_at ASC LIMIT 1`
        )
        .get<JobRow>(`"projectId":"${projectId}"`);
      if (existing) return rowToJob(existing);
    }
  }

  const id = randomUUID();
  const ts = nowIso();
  await db.prepare(
    `INSERT INTO background_jobs
      (id, type, status, payload_json, progress_json, result_json, error, attempt, max_attempts,
       available_at, locked_by, locked_at, created_at, updated_at)
     VALUES (?, ?, 'queued', ?, NULL, NULL, NULL, 0, ?, NULL, NULL, NULL, ?, ?)`
  ).run(id, type, JSON.stringify(payload ?? {}), DEFAULT_MAX_ATTEMPTS, ts, ts);

  return (await getJob(id))!;
}

export async function hasActiveGridGuideJob(projectId: string) {
  await ensureJobsTable();
  const id = String(projectId || '').trim();
  if (!id) return false;
  const row = await getDb()
    .prepare(
      `SELECT id FROM background_jobs
       WHERE type = 'grid-guide-task'
         AND status IN ('queued', 'running')
         AND position(? in payload_json) > 0
       LIMIT 1`
    )
    .get<{ id: string }>(`"projectId":"${id}"`);
  return Boolean(row);
}

export async function cancelQueuedPptVoiceJobs(projectId: string) {
  await ensureJobsTable();
  const id = String(projectId || '').trim();
  if (!id) return 0;
  const ts = nowIso();
  const result = await getDb()
    .prepare(
      `UPDATE background_jobs
       SET status = 'cancelled', error = ?, updated_at = ?
       WHERE type = 'ppt-voice-build'
         AND status = 'queued'
         AND position(? in payload_json) > 0`
    )
    .run('已取消重复的配音任务', ts, `"projectId":"${id}"`);
  return result.changes;
}

export async function cancelQueuedGridGuideJobs(projectId: string, keepJobId?: string) {
  await ensureJobsTable();
  const id = String(projectId || '').trim();
  if (!id) return 0;
  const ts = nowIso();
  const keepId = String(keepJobId || '').trim();
  const result = keepId
    ? await getDb()
        .prepare(
          `UPDATE background_jobs
           SET status = 'cancelled', error = ?, updated_at = ?
           WHERE type = 'grid-guide-task'
             AND status = 'queued'
             AND position(? in payload_json) > 0
             AND id != ?`
        )
        .run('已取消重复的指南任务', ts, `"projectId":"${id}"`, keepId)
    : await getDb()
        .prepare(
          `UPDATE background_jobs
           SET status = 'cancelled', error = ?, updated_at = ?
           WHERE type = 'grid-guide-task'
             AND status = 'queued'
             AND position(? in payload_json) > 0`
        )
        .run('已取消重复的指南任务', ts, `"projectId":"${id}"`);
  return result.changes;
}

export async function getJob(id: string): Promise<BackgroundJob | null> {
  await ensureJobsTable();
  const row = await getDb().prepare('SELECT * FROM background_jobs WHERE id = ?').get<JobRow>(id);
  return row ? rowToJob(row) : null;
}

export async function listJobs(opts: {
  type?: JobType;
  status?: JobStatus;
  limit?: number;
} = {}): Promise<BackgroundJob[]> {
  await ensureJobsTable();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.type) {
    clauses.push('type = ?');
    params.push(opts.type);
  }
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await getDb()
    .prepare(
      `SELECT * FROM background_jobs ${where}
       ORDER BY created_at DESC LIMIT ?`
    )
    .all<JobRow>(...params, limit);
  return rows.map(rowToJob);
}

export async function hasActiveSchemeResearchJob(sessionId: string) {
  await ensureJobsTable();
  const id = String(sessionId || '').trim();
  if (!id) return false;
  const row = await getDb()
    .prepare(
      `SELECT id FROM background_jobs
       WHERE type = 'scheme-research'
         AND status IN ('queued', 'running')
         AND position(? in payload_json) > 0
       LIMIT 1`
    )
    .get<{ id: string }>(`"sessionId":"${id}"`);
  return Boolean(row);
}

export async function hasActiveSerialJob(type: JobType): Promise<boolean> {
  await ensureJobsTable();
  const row = await getDb()
    .prepare(
      `SELECT id FROM background_jobs
       WHERE type = ? AND status IN ('queued', 'running')
       LIMIT 1`
    )
    .get<{ id: string }>(type);
  return Boolean(row);
}

export async function claimNextJob(workerId: string): Promise<BackgroundJob | null> {
  await ensureJobsTable();
  const db = getDb();
  return db.transaction(async () => {
    const candidates = await db
      .prepare(
        `SELECT * FROM background_jobs
         WHERE status = 'queued'
           AND (available_at IS NULL OR available_at <= ?)
         ORDER BY COALESCE(available_at, created_at) ASC, created_at ASC
         LIMIT 20`
      )
      .all<JobRow>(nowIso());

    for (const row of candidates) {
      const type = row.type as JobType;
      if (EXCLUSIVE_CLAIM_JOB_TYPES.has(type)) {
        const running = await db
          .prepare(
            `SELECT id FROM background_jobs
             WHERE type = ? AND status = 'running'
             LIMIT 1`
          )
          .get<{ id: string }>(type);
        if (running) continue;
      }

      const ts = nowIso();
      const updated = await db
        .prepare(
          `UPDATE background_jobs
           SET status = 'running', attempt = attempt + 1, available_at = NULL,
               locked_by = ?, locked_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(workerId, ts, ts, row.id);
      if (updated.changes > 0) {
        return rowToJob(
          (await db.prepare('SELECT * FROM background_jobs WHERE id = ?').get<JobRow>(row.id)) as JobRow
        );
      }
    }
    return null;
  });
}

export async function updateJobProgress(id: string, progress: Record<string, unknown>) {
  await ensureJobsTable();
  const ts = nowIso();
  await getDb()
    .prepare(
      `UPDATE background_jobs
       SET progress_json = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(JSON.stringify(progress), ts, id);
}

export async function finishJob(id: string, result?: unknown) {
  await ensureJobsTable();
  const ts = nowIso();
  await getDb()
    .prepare(
      `UPDATE background_jobs
       SET status = 'done', result_json = ?, error = NULL,
           locked_by = NULL, locked_at = NULL, updated_at = ?
       WHERE id = ?`
    )
    .run(result === undefined ? null : JSON.stringify(result), ts, id);
}

export async function failJob(id: string, error: string) {
  await ensureJobsTable();
  const db = getDb();
  const job = await db.prepare(
    'SELECT attempt, max_attempts FROM background_jobs WHERE id = ?'
  ).get<{ attempt: number; max_attempts: number }>(id);
  if (!job) return 'missing' as const;
  const ts = nowIso();
  const attempt = Math.max(1, Number(job.attempt || 1));
  const maxAttempts = Math.max(1, Number(job.max_attempts || DEFAULT_MAX_ATTEMPTS));
  if (attempt < maxAttempts) {
    const delayMs = Math.min(5 * 60_000, RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
    const availableAt = new Date(Date.now() + delayMs).toISOString();
    await db.prepare(
      `UPDATE background_jobs
       SET status = 'queued', error = ?, available_at = ?,
           locked_by = NULL, locked_at = NULL, updated_at = ?
       WHERE id = ?`
    ).run(error, availableAt, ts, id);
    return 'retrying' as const;
  }
  await db
    .prepare(
      `UPDATE background_jobs
       SET status = 'error', error = ?,
           available_at = NULL, locked_by = NULL, locked_at = NULL, updated_at = ?
       WHERE id = ?`
    )
    .run(error, ts, id);
  return 'error' as const;
}

export async function cancelJob(id: string): Promise<BackgroundJob | null> {
  await ensureJobsTable();
  const ts = nowIso();
  const db = getDb();
  await db
    .prepare(
      `UPDATE background_jobs
       SET status = 'cancelled', locked_by = NULL, locked_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`
    )
    .run(ts, id);
  return await getJob(id);
}

/** Re-queue jobs stuck in running longer than STALE_MS (crashed workers). */
export async function recoverStaleJobs(staleMs = STALE_MS): Promise<number> {
  await ensureJobsTable();
  const db = getDb();
  const running = await db
    .prepare(`SELECT id, type, attempt, max_attempts, locked_at, updated_at FROM background_jobs WHERE status = 'running'`)
    .all<{ id: string; type: string; attempt: number; max_attempts: number; locked_at: string | null; updated_at: string }>();

  let recovered = 0;
  const ts = nowIso();
  for (const row of running) {
    const rowStaleMs =
      row.type === 'scheme-research'
        ? SCHEME_RESEARCH_STALE_MS
        : row.type === 'grid-guide-task'
          ? GRID_GUIDE_STALE_MS
          : staleMs;
    const rowCutoff = Date.now() - rowStaleMs;
    const stamp = row.updated_at || row.locked_at || '';
    const t = Date.parse(stamp);
    if (!Number.isFinite(t) || t > rowCutoff) continue;
    const exhausted = Number(row.attempt || 0) >= Math.max(1, Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS));
    const availableAt = exhausted
      ? null
      : new Date(Date.now() + RETRY_BASE_MS).toISOString();
    await db.prepare(
      `UPDATE background_jobs
       SET status = ?, available_at = ?, locked_by = NULL, locked_at = NULL, updated_at = ?,
           error = COALESCE(error, 'recovered from stale lock')
       WHERE id = ? AND status = 'running'`
    ).run(exhausted ? 'error' : 'queued', availableAt, ts, row.id);
    recovered += 1;
  }
  return recovered;
}
