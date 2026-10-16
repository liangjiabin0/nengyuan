import crypto from 'node:crypto';
import { all, get, run, withTransaction } from '@/lib/db';
import { deleteOpenCodeSessionMapping } from '@/lib/opencode/runtime';
import { mergeAgentSteps } from './agent-trace';
import { deleteSchemeSolveAttachments } from './attachments';
import {
  SCHEME_SESSION_FILE,
  SCHEME_STAGE_KEYS,
  SCHEME_STAGE_LABELS
} from './constants';
import {
  readStageAgentTrace,
  type SchemeAgentTrace,
  type SchemeBrainstormPayload,
  type SchemeEvent,
  type SchemeEventLevel,
  type SchemeIdea,
  type SchemeIdeaView,
  type SchemeSession,
  type SchemeSessionSnapshot,
  type SchemeSessionSource,
  type SchemeSessionStatus,
  type SchemeProblemClass,
  type SchemeStage,
  type SchemeStageKey,
  type SchemeStageStatus
} from './types';
import { deleteSchemeSolveWorkspace } from './workspace';

type SessionRow = {
  chat_model?: SchemeSession["chatModel"] | null;
  thinking_id?: string | null;
  id: string;
  title: string;
  seed_idea: string;
  status: SchemeSessionStatus;
  progress: number;
  progress_detail: string;
  user_id: string | null;
  error: string | null;
  source?: string | null;
  tool_id?: string | null;
  created_at: string;
  updated_at: string;
};

type IdeaRow = {
  id: string;
  session_id: string;
  parent_id: string | null;
  title: string;
  summary: string;
  solvability: SchemeIdea['solvability'];
  reject_reason: string | null;
  problem_class: SchemeIdea['problemClass'] | null;
  decisions: string | null;
  limits: string | null;
  goal: string | null;
  case_hint: string | null;
  why_solvable: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type StageRow = {
  id: string;
  session_id: string;
  idea_id: string;
  stage_key: SchemeStageKey;
  status: SchemeStageStatus;
  headline: string;
  detail: string | null;
  artifact_json: string | null;
  updated_at: string;
};

type EventRow = {
  id: number;
  session_id: string;
  idea_id: string | null;
  stage: string | null;
  level: SchemeEventLevel;
  text: string;
  created_at: string;
};

export function assertSchemeId(value: string) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('无效的方案求解 ID。');
  return id;
}

function mapSession(row: SessionRow): SchemeSession {
  const source = row.source === 'virtual-sim' ? 'virtual-sim' : 'scheme-solve';
  const toolId = row.tool_id as SchemeProblemClass | null;
  return {
    id: row.id,
    title: row.title,
    seedIdea: row.seed_idea,
    chatModel: row.chat_model || undefined,
    thinkingId: row.thinking_id || undefined,
    status: row.status,
    progress: row.progress,
    progressDetail: row.progress_detail || undefined,
    error: row.error || undefined,
    source,
    toolId: toolId || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapIdea(row: IdeaRow): SchemeIdea {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id,
    title: row.title,
    summary: row.summary,
    solvability: row.solvability,
    rejectReason: row.reject_reason || undefined,
    problemClass: row.problem_class || undefined,
    decisions: row.decisions || undefined,
    limits: row.limits || undefined,
    goal: row.goal || undefined,
    caseHint: row.case_hint || undefined,
    whySolvable: row.why_solvable || undefined,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapStage(row: StageRow): SchemeStage {
  let artifactJson: unknown;
  if (row.artifact_json) {
    try {
      artifactJson = JSON.parse(row.artifact_json);
    } catch {
      artifactJson = undefined;
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    ideaId: row.idea_id,
    key: row.stage_key,
    status: row.status,
    headline: row.headline,
    detail: row.detail || undefined,
    artifactJson,
    updatedAt: row.updated_at
  };
}

function mapEvent(row: EventRow): SchemeEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    ideaId: row.idea_id || undefined,
    stage: (row.stage || undefined) as SchemeEvent['stage'],
    level: row.level,
    text: row.text,
    createdAt: row.created_at
  };
}

export async function createSchemeSession(
  seedIdea: string,
  userId: string,
  options?: { source?: SchemeSessionSource; toolId?: SchemeProblemClass; chatModel?: SchemeSession["chatModel"]; thinkingId?: string }
) {
  const id = crypto.randomUUID();
  const compact = seedIdea.replace(/\s+/g, ' ').trim();
  if (compact.length < 4) throw new Error('请至少用几句话描述想法。');
  const title = compact.length > 28 ? `${compact.slice(0, 28)}…` : compact;
  await run(
    `INSERT INTO scheme_sessions (id, title, seed_idea, status, user_id, source, tool_id, chat_model, thinking_id)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    [id, title, compact, userId, options?.source || 'scheme-solve', options?.toolId || null, options?.chatModel || null, options?.thinkingId || null]
  );
  return await getSchemeSession(id);
}

export async function listSchemeSessions(
  userId: string,
  options?: { source?: SchemeSessionSource; toolId?: string }
) {
  const source = options?.source ?? 'scheme-solve';
  if (options?.toolId) {
    const rows = await all<SessionRow>(
      `SELECT * FROM scheme_sessions
       WHERE user_id = ? AND COALESCE(source, 'scheme-solve') = ? AND tool_id = ?
       ORDER BY updated_at DESC, created_at DESC`,
      [userId, source, options.toolId]
    );
    return rows.map(mapSession);
  }
  const rows = await all<SessionRow>(
    `SELECT * FROM scheme_sessions
     WHERE user_id = ? AND COALESCE(source, 'scheme-solve') = ?
     ORDER BY updated_at DESC, created_at DESC`,
    [userId, source]
  );
  return rows.map(mapSession);
}

export async function assertSchemeOwner(sessionId: string, userId: string) {
  const row = await get<SessionRow>('SELECT * FROM scheme_sessions WHERE id = ?', [assertSchemeId(sessionId)]);
  if (!row) return { exists: false, allowed: false };
  return { exists: true, allowed: row.user_id === userId };
}

export async function getSchemeSession(sessionId: string): Promise<SchemeSession | null> {
  const row = await get<SessionRow>('SELECT * FROM scheme_sessions WHERE id = ?', [assertSchemeId(sessionId)]);
  return row ? mapSession(row) : null;
}

export async function listSchemeIdeas(sessionId: string) {
  const rows = await all<IdeaRow>(
    'SELECT * FROM scheme_ideas WHERE session_id = ? ORDER BY sort_order, created_at',
    [assertSchemeId(sessionId)]
  );
  return rows.map(mapIdea);
}

export async function getSchemeIdea(ideaId: string) {
  const row = await get<IdeaRow>('SELECT * FROM scheme_ideas WHERE id = ?', [assertSchemeId(ideaId)]);
  return row ? mapIdea(row) : null;
}

export async function listSchemeStages(sessionId: string, ideaId?: string) {
  if (ideaId) {
    const rows = await all<StageRow>(
      'SELECT * FROM scheme_stages WHERE session_id = ? AND idea_id = ?',
      [assertSchemeId(sessionId), assertSchemeId(ideaId)]
    );
    return rows.map(mapStage);
  }
  const rows = await all<StageRow>(
    'SELECT * FROM scheme_stages WHERE session_id = ?',
    [assertSchemeId(sessionId)]
  );
  return rows.map(mapStage);
}

export async function listSchemeEvents(sessionId: string, after = 0, limit = 800) {
  const id = assertSchemeId(sessionId);
  const take = Math.max(1, Math.min(500, limit));
  if (after > 0) {
    const rows = await all<EventRow>(
      'SELECT * FROM scheme_events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      [id, after, take]
    );
    return rows.map(mapEvent);
  }
  const rows = await all<EventRow>(
    'SELECT * FROM scheme_events WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    [id, take]
  );
  return rows.reverse().map(mapEvent);
}

export async function getSchemeSnapshot(sessionId: string, eventAfter = 0): Promise<SchemeSessionSnapshot | null> {
  const session = await getSchemeSession(sessionId);
  if (!session) return null;
  const ideas = await listSchemeIdeas(sessionId);
  const stages = await listSchemeStages(sessionId);
  const byIdea = new Map<string, SchemeStage[]>();
  for (const stage of stages) {
    const list = byIdea.get(stage.ideaId) || [];
    list.push(stage);
    byIdea.set(stage.ideaId, list);
  }
  const ideaViews: SchemeIdeaView[] = ideas.map((idea) => ({
    ...idea,
    stages: (byIdea.get(idea.id) || []).sort(
      (left, right) => SCHEME_STAGE_KEYS.indexOf(left.key) - SCHEME_STAGE_KEYS.indexOf(right.key)
    )
  }));
  return {
    ...session,
    ideas: ideaViews,
    events: await listSchemeEvents(sessionId, eventAfter)
  };
}

export async function setSchemeSessionStatus(
  sessionId: string,
  status: SchemeSessionStatus,
  extra?: { progress?: number; detail?: string; error?: string | null; title?: string }
) {
  const progress =
    extra?.progress ??
    (status === 'done' ? 100 : status === 'draft' ? 0 : undefined);
  await run(
    `UPDATE scheme_sessions
     SET status = ?,
         progress = COALESCE(?, progress),
         progress_detail = COALESCE(?, progress_detail),
         error = ?,
         title = COALESCE(NULLIF(?, ''), title),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      status,
      progress,
      extra?.detail ?? null,
      extra?.error === undefined ? null : extra.error,
      extra?.title || '',
      assertSchemeId(sessionId)
    ]
  );
}

export async function setSchemeSessionProgress(sessionId: string, progress: number, detail: string) {
  await run(
    `UPDATE scheme_sessions
     SET progress = ?, progress_detail = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [Math.max(0, Math.min(99, Math.round(progress))), detail.trim(), assertSchemeId(sessionId)]
  );
}

export async function appendSchemeEvent(input: {
  sessionId: string;
  ideaId?: string;
  stage?: SchemeEvent['stage'];
  level?: SchemeEventLevel;
  text: string;
}) {
  await run(
    `INSERT INTO scheme_events (session_id, idea_id, stage, level, text)
     VALUES (?, ?, ?, ?, ?)`,
    [
      assertSchemeId(input.sessionId),
      input.ideaId ? assertSchemeId(input.ideaId) : null,
      input.stage || 'session',
      input.level || 'info',
      input.text.trim().slice(0, 4000)
    ]
  );
  await run('UPDATE scheme_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [input.sessionId]);
}

export async function mergeSchemeStageArtifact(ideaId: string, key: SchemeStageKey, patch: SchemeAgentTrace) {
  const row = await get<StageRow>(
    'SELECT * FROM scheme_stages WHERE idea_id = ? AND stage_key = ?',
    [assertSchemeId(ideaId), key]
  );
  if (!row) return;
  let parsed: unknown;
  if (row.artifact_json) {
    try {
      parsed = JSON.parse(row.artifact_json);
    } catch {
      parsed = undefined;
    }
  }
  const current = readStageAgentTrace({ artifactJson: parsed });
  const next: SchemeAgentTrace = {
    kind: 'agent',
    agentName: patch.agentName || current.agentName,
    agentUid: current.agentUid,
    agentUid2: current.agentUid2,
    output: patch.output ?? current.output,
    steps: mergeAgentSteps(current.steps, patch.steps)
  };
  if (patch.agentUid) {
    if (!current.agentUid || current.agentUid === patch.agentUid) next.agentUid = patch.agentUid;
    else if (!current.agentUid2 && current.agentUid !== patch.agentUid) next.agentUid2 = patch.agentUid;
  }
  await updateSchemeStage(ideaId, key, { artifactJson: next });
}

export async function updateSchemeStage(
  ideaId: string,
  key: SchemeStageKey,
  patch: {
    status?: SchemeStageStatus;
    headline?: string;
    detail?: string;
    artifactJson?: unknown;
  }
) {
  const row = await get<StageRow>(
    'SELECT * FROM scheme_stages WHERE idea_id = ? AND stage_key = ?',
    [assertSchemeId(ideaId), key]
  );
  if (!row) return;
  await run(
    `UPDATE scheme_stages
     SET status = COALESCE(?, status),
         headline = COALESCE(?, headline),
         detail = COALESCE(?, detail),
         artifact_json = COALESCE(?, artifact_json),
         updated_at = CURRENT_TIMESTAMP
     WHERE idea_id = ? AND stage_key = ?`,
    [
      patch.status ?? null,
      patch.headline?.trim() || null,
      patch.detail?.trim() || null,
      patch.artifactJson === undefined ? null : JSON.stringify(patch.artifactJson),
      ideaId,
      key
    ]
  );
}

export async function createSolvableIdea(
  sessionId: string,
  input: {
    title: string;
    summary: string;
    problemClass: SchemeProblemClass;
    decisions?: string;
    limits?: string;
    goal?: string;
    caseHint?: string;
    whySolvable?: string;
  }
) {
  const id = assertSchemeId(sessionId);
  const ideas = await listSchemeIdeas(id);
  const sortOrder = Math.max(0, ...ideas.map((item) => item.sortOrder)) + 1;
  const ideaId = crypto.randomUUID();
  const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 80) || '仿真任务';
  return withTransaction(async () => {
    await run(
      `INSERT INTO scheme_ideas (
         id, session_id, parent_id, title, summary, solvability, problem_class,
         decisions, limits, goal, case_hint, why_solvable, sort_order
       ) VALUES (?, ?, NULL, ?, ?, 'solvable', ?, ?, ?, ?, ?, ?, ?)`,
      [
        ideaId,
        id,
        title,
        input.summary.trim(),
        input.problemClass,
        input.decisions || '',
        input.limits || '',
        input.goal || '',
        input.caseHint || null,
        input.whySolvable || '',
        sortOrder
      ]
    );
    for (const key of SCHEME_STAGE_KEYS) {
      const isIdea = key === 'idea';
      await run(
        `INSERT INTO scheme_stages (id, session_id, idea_id, stage_key, status, headline)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          ideaId,
          key,
          isIdea ? 'done' : 'idle',
          isIdea ? input.summary.trim().slice(0, 80) : `等待${SCHEME_STAGE_LABELS[key]}`
        ]
      );
    }
    return (await getSchemeIdea(ideaId))!;
  });
}

export async function cloneSchemeIdea(ideaId: string, titleSuffix = '（对比情景）') {
  const idea = await getSchemeIdea(ideaId);
  if (!idea) throw new Error('想法不存在。');
  const ideas = await listSchemeIdeas(idea.sessionId);
  const sortOrder = Math.max(0, ...ideas.map((item) => item.sortOrder)) + 1;
  const newId = crypto.randomUUID();
  const title = `${idea.title}${titleSuffix}`.slice(0, 80);
  return withTransaction(async () => {
    await run(
      `INSERT INTO scheme_ideas (
         id, session_id, parent_id, title, summary, solvability, problem_class,
         decisions, limits, goal, case_hint, why_solvable, sort_order
       ) VALUES (?, ?, ?, ?, ?, 'solvable', ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId,
        idea.sessionId,
        idea.id,
        title,
        idea.summary,
        idea.problemClass || 'mgplan',
        idea.decisions || '',
        idea.limits || '',
        idea.goal || '',
        idea.caseHint || 'sSEP',
        idea.whySolvable || '由已有规划情景复制，用于对比。',
        sortOrder
      ]
    );
    for (const key of SCHEME_STAGE_KEYS) {
      const isIdea = key === 'idea';
      await run(
        `INSERT INTO scheme_stages (id, session_id, idea_id, stage_key, status, headline)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          idea.sessionId,
          newId,
          key,
          isIdea ? 'done' : 'idle',
          isIdea ? `${title}`.slice(0, 80) : `等待${SCHEME_STAGE_LABELS[key]}`
        ]
      );
    }
    return (await getSchemeIdea(newId))!;
  });
}

export async function replaceBrainstormTree(sessionId: string, payload: SchemeBrainstormPayload) {
  const id = assertSchemeId(sessionId);
  return withTransaction(async () => {
    await run('DELETE FROM scheme_stages WHERE session_id = ?', [id]);
    await run('DELETE FROM scheme_ideas WHERE session_id = ?', [id]);
    const created: SchemeIdea[] = [];
    for (const [index, item] of payload.ideas.entries()) {
      const ideaId = crypto.randomUUID();
      await run(
        `INSERT INTO scheme_ideas (
           id, session_id, parent_id, title, summary, solvability, problem_class,
           decisions, limits, goal, case_hint, why_solvable, sort_order
         ) VALUES (?, ?, NULL, ?, ?, 'solvable', ?, ?, ?, ?, ?, ?, ?)`,
        [
          ideaId,
          id,
          item.title,
          item.summary,
          item.problemClass,
          item.decisions,
          item.limits,
          item.goal,
          item.caseHint || null,
          item.whySolvable,
          index
        ]
      );
      for (const key of SCHEME_STAGE_KEYS) {
        const isIdea = key === 'idea';
        await run(
          `INSERT INTO scheme_stages (id, session_id, idea_id, stage_key, status, headline)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            crypto.randomUUID(),
            id,
            ideaId,
            key,
            isIdea ? 'done' : 'idle',
            isIdea ? item.summary.slice(0, 80) : `等待${SCHEME_STAGE_LABELS[key]}`
          ]
        );
      }
      created.push((await getSchemeIdea(ideaId))!);
    }
    for (const [index, item] of payload.rejected.entries()) {
      const ideaId = crypto.randomUUID();
      await run(
        `INSERT INTO scheme_ideas (
           id, session_id, parent_id, title, summary, solvability, reject_reason, sort_order
         ) VALUES (?, ?, NULL, ?, ?, 'rejected', ?, ?)`,
        [ideaId, id, item.title, item.reason, item.reason, payload.ideas.length + index]
      );
      await run(
        `INSERT INTO scheme_stages (id, session_id, idea_id, stage_key, status, headline)
         VALUES (?, ?, ?, 'idea', 'skipped', ?)`,
        [crypto.randomUUID(), id, ideaId, item.reason.slice(0, 80)]
      );
    }
    const title = payload.ideas[0]?.title || payload.rejected[0]?.title || '';
    await setSchemeSessionStatus(id, 'ready', {
      progress: 20,
      detail: `已形成 ${payload.ideas.length} 条可研究想法` +
        (payload.rejected.length ? `，${payload.rejected.length} 条不可研究` : ''),
      error: null,
      title
    });
    return created;
  });
}

export async function refreshSessionAggregate(sessionId: string) {
  const ideas = (await listSchemeIdeas(sessionId)).filter((idea) => idea.solvability === 'solvable');
  if (!ideas.length) {
    await setSchemeSessionStatus(sessionId, 'ready', { progress: 20, detail: '没有可研究想法', error: null });
    return;
  }
  const stages = await listSchemeStages(sessionId);
  const byIdea = new Map<string, SchemeStage[]>();
  for (const stage of stages) {
    const list = byIdea.get(stage.ideaId) || [];
    list.push(stage);
    byIdea.set(stage.ideaId, list);
  }
  let solved = 0;
  let failed = 0;
  let running = 0;
  let reported = 0;
  for (const idea of ideas) {
    const ideaStages = byIdea.get(idea.id) || [];
    if (ideaStages.some((stage) => stage.status === 'running')) running += 1;
    if (ideaStages.some((stage) => stage.key === 'report' && stage.status === 'done')) reported += 1;
    if (ideaStages.some((stage) => stage.key === 'solve' && stage.status === 'done')) solved += 1;
    else if (ideaStages.some((stage) => stage.status === 'failed')) failed += 1;
  }
  if (reported > 0 && running === 0) {
    await setSchemeSessionStatus(sessionId, 'done', {
      progress: 100,
      detail: '最优方案已完成审查与报告',
      error: null
    });
    return;
  }
  if (running > 0) {
    const progress = 20 + Math.round(((solved + failed) / ideas.length) * 70);
    await setSchemeSessionStatus(sessionId, 'researching', {
      progress,
      detail: reported
        ? '正在收尾'
        : `研究中：已求出 ${solved}/${ideas.length}` + (failed ? `，失败 ${failed}` : ''),
      error: null
    });
    return;
  }
  if (solved + failed === ideas.length) {
    if (!solved) {
      await setSchemeSessionStatus(sessionId, 'failed', {
        progress: 100,
        detail: '全部想法求解失败',
        error: '全部想法研究失败'
      });
      return;
    }
    await setSchemeSessionStatus(sessionId, 'ready', {
      progress: 20 + Math.round((solved / ideas.length) * 70),
      detail: `已求出 ${solved} 个方案，待审查最优`,
      error: null
    });
    return;
  }
  await setSchemeSessionStatus(sessionId, 'ready', {
    progress: 20 + Math.round((solved / ideas.length) * 70),
    detail: `可继续研究：已求出 ${solved}/${ideas.length}`,
    error: null
  });
}

export async function deleteSchemeSession(sessionId: string) {
  const id = assertSchemeId(sessionId);
  const ideas = await listSchemeIdeas(id);
  await deleteSchemeSolveAttachments(id);
  deleteSchemeSolveWorkspace(id);
  deleteOpenCodeSessionMapping(`scheme-brainstorm:${id}`, SCHEME_SESSION_FILE);
  for (const idea of ideas) {
    for (const suffix of ['design', 'review-small', 'review-large', 'write'] as const) {
      deleteOpenCodeSessionMapping(`scheme-${suffix}:${id}:${idea.id}`, SCHEME_SESSION_FILE);
    }
  }
  await withTransaction(async (database) => {
    await database.prepare('DELETE FROM scheme_events WHERE session_id = ?').run(id);
    await database.prepare('DELETE FROM scheme_stages WHERE session_id = ?').run(id);
    await database.prepare('DELETE FROM scheme_ideas WHERE session_id = ?').run(id);
    await database.prepare('DELETE FROM scheme_sessions WHERE id = ?').run(id);
  });
}

export async function listSolvableIdeaIds(sessionId: string) {
  return (await listSchemeIdeas(sessionId))
    .filter((idea) => idea.solvability === 'solvable')
    .map((idea) => idea.id);
}

export async function ideaHasActiveStage(ideaId: string) {
  return Boolean(
    await get<StageRow>(
      `SELECT id FROM scheme_stages WHERE idea_id = ? AND status = 'running' LIMIT 1`,
      [assertSchemeId(ideaId)]
    )
  );
}
