import crypto from 'node:crypto';
import { all, get, run } from '../db';
import {
  PAPER_REVIEW_STAGES,
  type ArtifactEntry,
  type InputFile,
  type PaperReviewOptions,
  type PaperReviewStage,
  type PaperReviewStatus,
  type StageState
} from './types';
import type { ModelUsageRecord } from './llm';

type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  status: PaperReviewStatus;
  stage: string;
  progress: number;
  progress_detail: string | null;
  options_json: string;
  inputs_json: string;
  paper_sha256: string | null;
  skills_json: string | null;
  model_json: string | null;
  stages_json: string;
  usage_json: string;
  artifacts_json: string;
  gates_json: string;
  error: string | null;
  cancel_requested: number;
  heartbeat_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PaperReviewTask = {
  id: string;
  userId: string;
  title: string;
  status: PaperReviewStatus;
  stage: string;
  progress: number;
  progressDetail: string;
  options: PaperReviewOptions;
  inputs: InputFile[];
  paperSha256: string | null;
  skills: Record<string, unknown> | null;
  model: Record<string, unknown> | null;
  stages: Partial<Record<PaperReviewStage, StageState>>;
  usage: ModelUsageRecord[];
  artifacts: ArtifactEntry[];
  gates: Record<string, { passed: boolean; detail?: string }>;
  error: string | null;
  cancelRequested: boolean;
  heartbeatAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapTask(row: TaskRow): PaperReviewTask {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress || 0),
    progressDetail: row.progress_detail || '',
    options: parse(row.options_json, {} as PaperReviewOptions),
    inputs: parse(row.inputs_json, []),
    paperSha256: row.paper_sha256,
    skills: parse(row.skills_json, null),
    model: parse(row.model_json, null),
    stages: parse(row.stages_json, {}),
    usage: parse(row.usage_json, []),
    artifacts: parse(row.artifacts_json, []),
    gates: parse(row.gates_json, {}),
    error: row.error,
    cancelRequested: Boolean(row.cancel_requested),
    heartbeatAt: row.heartbeat_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const now = () => new Date().toISOString();

export async function createPaperReviewTask(input: { userId: string; title: string; options: PaperReviewOptions; inputs: InputFile[]; paperSha256: string | null; id?: string }) {
  const id = input.id || crypto.randomUUID();
  const ts = now();
  await run(
    `INSERT INTO paper_review_tasks (id, user_id, title, status, stage, options_json, inputs_json, paper_sha256, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', 'queued', ?, ?, ?, ?, ?)`,
    [id, input.userId, input.title, JSON.stringify(input.options), JSON.stringify(input.inputs), input.paperSha256, ts, ts]
  );
  return (await getPaperReviewTask(id))!;
}

export async function getPaperReviewTask(id: string) {
  const row = await get<TaskRow>('SELECT * FROM paper_review_tasks WHERE id = ?', [id]);
  return row ? mapTask(row) : null;
}

/** 所有权校验：普通用户只能访问自己的任务；管理员按既有策略可读全部。 */
export async function assertPaperReviewOwner(id: string, userId: string, isAdmin = false) {
  const task = await getPaperReviewTask(id);
  if (!task) return { exists: false, allowed: false, task: null };
  return { exists: true, allowed: task.userId === userId || isAdmin, task };
}

export async function listPaperReviewTasks(userId: string, opts: { page?: number; pageSize?: number } = {}) {
  const pageSize = Math.min(100, Math.max(5, opts.pageSize || 30));
  const page = Math.max(1, opts.page || 1);
  const rows = await all<TaskRow>(
    `SELECT * FROM paper_review_tasks WHERE user_id = ? ORDER BY updated_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    [userId]
  );
  return rows.map(mapTask);
}

type Patch = Partial<{
  title: string;
  status: PaperReviewStatus;
  stage: string;
  progress: number;
  progressDetail: string;
  options: PaperReviewOptions;
  inputs: InputFile[];
  paperSha256: string | null;
  skills: Record<string, unknown> | null;
  model: Record<string, unknown> | null;
  stages: Partial<Record<PaperReviewStage, StageState>>;
  artifacts: ArtifactEntry[];
  gates: Record<string, { passed: boolean; detail?: string }>;
  error: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}>;

const COLUMN: Record<keyof Patch, [string, (v: never) => unknown]> = {
  title: ['title', (v) => v],
  status: ['status', (v) => v],
  stage: ['stage', (v) => v],
  progress: ['progress', (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)))],
  progressDetail: ['progress_detail', (v) => v],
  options: ['options_json', (v) => JSON.stringify(v)],
  inputs: ['inputs_json', (v) => JSON.stringify(v)],
  paperSha256: ['paper_sha256', (v) => v],
  skills: ['skills_json', (v) => JSON.stringify(v)],
  model: ['model_json', (v) => JSON.stringify(v)],
  stages: ['stages_json', (v) => JSON.stringify(v)],
  artifacts: ['artifacts_json', (v) => JSON.stringify(v)],
  gates: ['gates_json', (v) => JSON.stringify(v)],
  error: ['error', (v) => v],
  cancelRequested: ['cancel_requested', (v) => (v ? 1 : 0)],
  startedAt: ['started_at', (v) => v],
  finishedAt: ['finished_at', (v) => v]
};

export async function updatePaperReviewTask(id: string, patch: Patch) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof Patch, never]>) {
    if (value === undefined) continue;
    const [column, encode] = COLUMN[key];
    sets.push(`${column} = ?`);
    params.push(encode(value));
  }
  sets.push('updated_at = ?');
  params.push(now(), id);
  await run(`UPDATE paper_review_tasks SET ${sets.join(', ')} WHERE id = ?`, params);
}

/** 更新单个阶段状态（读-改-写在同一任务内串行，只有一个运行器写入）。 */
export async function setStageState(id: string, stage: PaperReviewStage, state: Partial<StageState>) {
  const task = await getPaperReviewTask(id);
  if (!task) return;
  const stages = { ...task.stages, [stage]: { ...(task.stages[stage] || { status: 'pending' }), ...state } };
  const index = PAPER_REVIEW_STAGES.indexOf(stage);
  const passed = PAPER_REVIEW_STAGES.filter((s) => stages[s]?.status === 'passed' || stages[s]?.status === 'skipped').length;
  await updatePaperReviewTask(id, {
    stages,
    stage,
    progress: Math.round((passed / PAPER_REVIEW_STAGES.length) * 100),
    progressDetail: state.detail ?? task.progressDetail
  });
  return { stages, index };
}

export async function appendUsage(id: string, usage: ModelUsageRecord) {
  const task = await getPaperReviewTask(id);
  if (!task) return;
  await run('UPDATE paper_review_tasks SET usage_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify([...task.usage, usage]), now(), id]);
}

export function totalTokens(task: Pick<PaperReviewTask, 'usage'>) {
  return task.usage.reduce((sum, u) => sum + u.promptTokens + u.completionTokens, 0);
}

export async function heartbeatPaperReviewTask(id: string) {
  await run('UPDATE paper_review_tasks SET heartbeat_at = ? WHERE id = ?', [now(), id]);
}

export async function isCancelRequested(id: string) {
  const row = await get<{ cancel_requested: number }>('SELECT cancel_requested FROM paper_review_tasks WHERE id = ?', [id]);
  return Boolean(row?.cancel_requested);
}

export async function appendPaperReviewEvent(taskId: string, event: { stage?: string; level?: 'info' | 'warn' | 'error' | 'success'; text: string; data?: unknown }) {
  await run(
    `INSERT INTO paper_review_events (task_id, stage, level, text, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [taskId, event.stage || null, event.level || 'info', event.text.slice(0, 4000), event.data === undefined ? null : JSON.stringify(event.data).slice(0, 20_000), now()]
  );
}

export async function listPaperReviewEvents(taskId: string, after = 0, limit = 300) {
  const rows = await all<{ id: number; stage: string | null; level: string; text: string; data_json: string | null; created_at: string }>(
    `SELECT id, stage, level, text, data_json, created_at FROM paper_review_events WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ${Math.min(1000, Math.max(1, limit))}`,
    [taskId, after]
  );
  return rows.map((r) => ({ id: Number(r.id), stage: r.stage, level: r.level, text: r.text, data: parse(r.data_json, null), createdAt: r.created_at }));
}

export async function deletePaperReviewTask(id: string) {
  await run('DELETE FROM paper_review_events WHERE task_id = ?', [id]);
  await run('DELETE FROM paper_review_proposals WHERE task_id = ?', [id]);
  await run('DELETE FROM paper_review_tasks WHERE id = ?', [id]);
}
