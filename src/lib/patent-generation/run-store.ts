import crypto from 'node:crypto';
import { all, get, getDb, run, withTransaction } from '@/lib/db';
import type {
  PatentGenerationEvent,
  PatentGenerationRun,
  PatentProgressEvent,
  PatentRunStatus,
  PatentStage
} from './types';
import { getPatentProject } from './store';

type RunRow = {
  id: string;
  project_id: string;
  status: PatentRunStatus;
  stage: PatentStage;
  progress: number;
  detail: string;
  error: string | null;
  attempt: number;
  input_hash: string;
  cancel_requested: number;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

type EventRow = {
  id: number;
  run_id: string;
  project_id: string;
  type: PatentProgressEvent['type'];
  stage: PatentStage | null;
  progress: number | null;
  detail: string | null;
  error: string | null;
  created_at: string;
};

const ACTIVE_STATUSES: PatentRunStatus[] = ['queued', 'running'];

function mapRun(row: RunRow): PatentGenerationRun {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress || 0),
    detail: row.detail || '',
    error: row.error || undefined,
    attempt: Number(row.attempt || 1),
    inputHash: row.input_hash,
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    heartbeatAt: row.heartbeat_at || undefined,
    finishedAt: row.finished_at || undefined,
    updatedAt: row.updated_at
  };
}

function mapEvent(row: EventRow): PatentGenerationEvent {
  return {
    id: Number(row.id),
    runId: row.run_id,
    projectId: row.project_id,
    type: row.type,
    stage: row.stage || undefined,
    progress: row.progress == null ? undefined : Number(row.progress),
    detail: row.detail || undefined,
    error: row.error || undefined,
    createdAt: row.created_at
  };
}

export async function patentInputHash(projectId: string) {
  const project = await getPatentProject(projectId);
  if (!project?.source) throw new Error('专利项目或源文件不存在。');
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      sourceId: project.source.id,
      sourceSize: project.source.size,
      applicant: project.applicant,
      inventors: project.inventors,
      answers: project.answers
    }))
    .digest('hex');
}

export async function getPatentRun(runId: string) {
  const row = await get<RunRow>('SELECT * FROM patent_generation_runs WHERE id = ?', [runId]);
  return row ? mapRun(row) : null;
}

export async function getLatestPatentRun(projectId: string) {
  const row = await get<RunRow>(
    'SELECT * FROM patent_generation_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    [projectId]
  );
  return row ? mapRun(row) : null;
}

export async function listPatentRunEvents(runId: string, after = 0) {
  const rows = await all<EventRow>(
    'SELECT * FROM patent_generation_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 500',
    [runId, Math.max(0, after)]
  );
  return rows.map(mapEvent);
}

export async function createPatentRun(projectId: string) {
  const inputHash = await patentInputHash(projectId);
  return withTransaction(async (database) => {
    const active = await database.prepare(
      `SELECT * FROM patent_generation_runs
       WHERE project_id = ? AND status IN ('queued', 'running')
       ORDER BY created_at DESC LIMIT 1`
    ).get<RunRow>(projectId);
    if (active) return mapRun(active);

    const previous = await database.prepare(
      'SELECT attempt FROM patent_generation_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get<{ attempt?: number }>(projectId);
    const id = crypto.randomUUID();
    const attempt = Number(previous?.attempt || 0) + 1;
    await database.prepare(
      `INSERT INTO patent_generation_runs
       (id, project_id, status, stage, progress, detail, attempt, input_hash)
       VALUES (?, ?, 'queued', 'source', 0, '任务已进入队列', ?, ?)`
    ).run(id, projectId, attempt, inputHash);
    await database.prepare(
      `UPDATE patent_projects
       SET status = 'queued', current_stage = 'source', error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(projectId);
    await database.prepare(
      `INSERT INTO patent_generation_events (run_id, project_id, type, stage, progress, detail)
       VALUES (?, ?, 'status', 'source', 0, '任务已进入队列')`
    ).run(id, projectId);
    const created = await database.prepare('SELECT * FROM patent_generation_runs WHERE id = ?').get<RunRow>(id);
    return mapRun(created as RunRow);
  });
}

export async function claimPatentRun(runId: string) {
  const result = await getDb().prepare(
    `UPDATE patent_generation_runs
     SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP::text),
         heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('queued', 'interrupted') AND cancel_requested = 0`
  ).run(runId);
  return Number(result.changes || 0) === 1;
}

export async function heartbeatPatentRun(runId: string) {
  await run(
    `UPDATE patent_generation_runs
     SET heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'running'`,
    [runId]
  );
}

export async function appendPatentRunEvent(runId: string, event: PatentProgressEvent) {
  const current = await getPatentRun(runId);
  if (!current) return;
  const stage = 'stage' in event ? event.stage || current.stage : current.stage;
  const progress = event.type === 'status' ? event.progress : current.progress;
  const detail = event.type === 'status' ? event.detail : event.type === 'artifact' ? `已生成：${event.kind}` : '';
  const error = event.type === 'error' ? event.error : null;
  await run(
    `INSERT INTO patent_generation_events
     (run_id, project_id, type, stage, progress, detail, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [runId, current.projectId, event.type, stage, progress, detail || null, error]
  );
  await run(
    `UPDATE patent_generation_runs
     SET stage = ?, progress = ?, detail = CASE WHEN ? <> '' THEN ? ELSE detail END,
         error = CASE WHEN ?::text IS NOT NULL THEN ?::text ELSE error END,
         heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [stage, progress, detail, detail, error, error, runId]
  );
}

export async function requestPatentRunCancel(projectId: string) {
  const latest = await getLatestPatentRun(projectId);
  if (!latest || !ACTIVE_STATUSES.includes(latest.status)) return latest;
  await run(
    `UPDATE patent_generation_runs
     SET cancel_requested = 1, detail = '正在取消…', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [latest.id]
  );
  return await getPatentRun(latest.id);
}

export async function finishPatentRun(
  runId: string,
  status: Exclude<PatentRunStatus, 'queued' | 'running'>,
  input: { stage?: PatentStage; detail?: string; error?: string } = {}
) {
  const current = await getPatentRun(runId);
  if (!current) return null;
  const progress = status === 'completed' || status === 'review_required' ? 100 : current.progress;
  await run(
    `UPDATE patent_generation_runs
     SET status = ?, stage = ?, progress = ?, detail = ?, error = ?,
         finished_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      status,
      input.stage || current.stage,
      progress,
      input.detail || current.detail,
      input.error || null,
      runId
    ]
  );
  await run(
    `UPDATE patent_projects
     SET status = ?, current_stage = ?, error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, input.stage || current.stage, input.error || null, current.projectId]
  );
  await run(
    `INSERT INTO patent_generation_events
     (run_id, project_id, type, stage, progress, detail, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      current.projectId,
      status === 'failed' ? 'error' : 'done',
      input.stage || current.stage,
      progress,
      input.detail || current.detail,
      input.error || null
    ]
  );
  return await getPatentRun(runId);
}

export async function recoverStalePatentRuns(maxHeartbeatAgeSeconds = 120) {
  await run(
    `UPDATE patent_generation_runs
     SET status = 'interrupted', detail = '服务中断，可从检查点继续', finished_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE status = 'running'
       AND (heartbeat_at IS NULL OR heartbeat_at < datetime('now', ?))`,
    [`-${Math.max(30, maxHeartbeatAgeSeconds)} seconds`]
  );
  await run(
    `UPDATE patent_projects
     SET status = 'interrupted', error = '生成服务曾中断，可点击继续生成。', updated_at = CURRENT_TIMESTAMP
     WHERE id IN (
       SELECT project_id FROM patent_generation_runs
       WHERE status = 'interrupted'
     ) AND status = 'processing'`
  );
}
