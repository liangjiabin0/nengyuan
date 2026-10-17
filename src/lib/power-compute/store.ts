import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDb, getDb } from "@/lib/db";
import { ensureJobsTable } from "@/lib/jobs/queue";
import { getPowerModel } from "./models";
import { asRunSpec, asResultBundle, specView, resultView } from "./contracts";
import { powerStorageDirectory } from "./paths";
import {
  inputHash,
  powerRequestSchema,
  PowerRunConflictError,
  type PowerRequest,
  type PowerResult,
  type PowerStatus,
} from "./schema";

export type PowerRun = {
  id: string;
  userId: string;
  sessionId: string | null;
  ideaId: string | null;
  jobId: string;
  status: PowerStatus;
  phase: string;
  error: string | null;
  spec: PowerRequest & {
    runId: string;
    inputHash: string;
    schemaVersion: string;
  };
  result: PowerResult | null;
  events: Array<{ at: string; phase: string; detail: string }>;
  createdAt: string;
  updatedAt: string;
};
type RunRow = {
  id: string;
  user_id: string;
  session_id: string | null;
  idea_id: string | null;
  job_id: string;
  status: PowerStatus;
  phase: string;
  error: string | null;
  spec_json: string;
  result_json: string | null;
  events_json: string;
  created_at: string;
  updated_at: string;
};
let schemaPromise: Promise<void> | null = null;
export function ensurePowerTables(): Promise<void> {
  schemaPromise ??= (async () => {
    await ensureDb();
    await ensureJobsTable();
    await getDb().exec(`CREATE TABLE IF NOT EXISTS power_runs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), session_id TEXT,
      idea_id TEXT, request_key TEXT NOT NULL, job_id TEXT NOT NULL, status TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'queued', error TEXT, lease_token TEXT,
      spec_json TEXT NOT NULL, result_json TEXT, events_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(user_id, request_key));
      CREATE INDEX IF NOT EXISTS power_runs_owner ON power_runs(user_id, session_id, created_at);`);
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}
function view(row: RunRow): PowerRun {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    ideaId: row.idea_id,
    jobId: row.job_id,
    status: row.status,
    phase: row.phase,
    error: row.error,
    spec: specView(JSON.parse(row.spec_json)),
    result: row.result_json ? resultView(JSON.parse(row.result_json)) : null,
    events: JSON.parse(row.events_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function runDirectory(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("无效运行编号");
  const base = powerStorageDirectory("power-runs");
  const directory = path.join(base, id);
  if (fs.existsSync(directory) && fs.realpathSync(directory) !== directory)
    throw new Error("运行目录存在非法链接");
  return directory;
}
export async function getPowerRun(userId: string, id: string) {
  await ensurePowerTables();
  const row = await getDb()
    .prepare("SELECT * FROM power_runs WHERE id = ? AND user_id = ?")
    .get<RunRow>(id, userId);
  return row ? view(row) : null;
}
export async function listPowerRuns(userId: string, sessionId?: string) {
  await ensurePowerTables();
  const rows = sessionId
    ? await getDb()
        .prepare(
          "SELECT id,user_id,session_id,idea_id,job_id,status,phase,error,spec_json,NULL AS result_json,'[]' AS events_json,created_at,updated_at FROM power_runs WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 100",
        )
        .all<RunRow>(userId, sessionId)
    : await getDb()
        .prepare(
          "SELECT id,user_id,session_id,idea_id,job_id,status,phase,error,spec_json,NULL AS result_json,'[]' AS events_json,created_at,updated_at FROM power_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100",
        )
        .all<RunRow>(userId);
  return rows.map(view);
}
export async function createPowerRun(userId: string, request: PowerRequest) {
  return (await createPowerRuns(userId, [request]))[0];
}
export async function createPowerRuns(
  userId: string,
  requests: PowerRequest[],
) {
  if (
    !requests.length ||
    requests.length > 5 ||
    new Set(requests.map((r) => r.requestKey)).size !== requests.length
  )
    throw new Error("每批须为 1—5 个任务且请求编号不可重复");
  await ensurePowerTables();
  const models = await Promise.all(
    requests.map(async (request) => {
      const model = request.modelUploadId
        ? await getPowerModel(userId, request.modelUploadId)
        : null;
      if (request.modelUploadId && (!model || model.engine !== request.engine))
        throw new Error("模型不存在或无权访问");
      if (model?.diagnosis_json) {
        const diagnosis = JSON.parse(model.diagnosis_json);
        if (!diagnosis.allowedAnalyses?.includes(request.parameters.analysis))
          throw new Error("模型不支持该分析；请先检查算例诊断");
      }
      return model;
    }),
  );
  return getDb().transaction(async (db) => {
    await db
      .prepare("SELECT pg_advisory_xact_lock(hashtextextended(?,0))")
      .get("power:" + userId);
    const values = [];
    for (const [index, request] of requests.entries()) {
      const model = models[index];
      const existing = await db
        .prepare(
          "SELECT * FROM power_runs WHERE user_id = ? AND request_key = ?",
        )
        .get<RunRow>(userId, request.requestKey);
      if (existing) {
        const previous = specView(
          JSON.parse(existing.spec_json),
        ) as PowerRequest & {
          inputHash: string;
        };
        const oldRequest = powerRequestSchema.safeParse({
          engine: previous.engine,
          modelId: previous.modelId,
          parameters: previous.parameters,
          requestKey: previous.requestKey,
          timeLimitSeconds: previous.timeLimitSeconds || 0,
          ...(previous.transport ? { transport: previous.transport } : {}),
          ...(previous.modelUploadId
            ? { modelUploadId: previous.modelUploadId }
            : {}),
          ...(previous.sessionId ? { sessionId: previous.sessionId } : {}),
          ...(previous.ideaId ? { ideaId: previous.ideaId } : {}),
        });
        if (
          inputHash(request) !==
            (oldRequest.success
              ? inputHash(oldRequest.data)
              : previous.inputHash) ||
          request.sessionId !== previous.sessionId ||
          request.ideaId !== previous.ideaId
        )
          throw new PowerRunConflictError(
            "同一请求编号不能用于不同参数或所属任务",
          );
        values.push({ run: view(existing), created: false });
        continue;
      }
      if (request.ideaId && !request.sessionId)
        throw new Error("方案节点必须关联所属会话");
      const count = await db
        .prepare(
          "SELECT COUNT(*) AS n FROM power_runs WHERE user_id=? AND status IN ('queued','running','cancel_requested')",
        )
        .get<{ n: string }>(userId);
      if (Number(count?.n) >= 5)
        throw new Error("同时最多保留 5 个待执行任务，请等待完成后再提交");
      if (request.sessionId) {
        const session = await db
          .prepare(
            "SELECT id FROM scheme_sessions WHERE id = ? AND user_id = ?",
          )
          .get(request.sessionId, userId);
        if (!session) throw new Error("方案不存在或无权访问");
        if (
          request.ideaId &&
          !(await db
            .prepare(
              "SELECT id FROM scheme_ideas WHERE id = ? AND session_id = ?",
            )
            .get(request.ideaId, request.sessionId))
        )
          throw new Error("方案节点不属于当前会话");
      }
      const id = randomUUID(),
        jobId = randomUUID(),
        at = new Date().toISOString();
      const spec = asRunSpec(request, id, inputHash(request), model?.sha256);
      await db
        .prepare(
          `INSERT INTO power_runs (id,user_id,session_id,idea_id,request_key,job_id,status,phase,spec_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'queued','queued',?,?,?)`,
        )
        .run(
          id,
          userId,
          request.sessionId ?? null,
          request.ideaId ?? null,
          request.requestKey,
          jobId,
          JSON.stringify(spec),
          at,
          at,
        );
      await db
        .prepare(
          `INSERT INTO background_jobs (id,type,status,payload_json,attempt,max_attempts,created_at,updated_at)
      VALUES (?,'power-compute','queued',?,0,1,?,?)`,
        )
        .run(jobId, JSON.stringify({ runId: id, userId }), at, at);
      values.push({
        run: view(
          (await db
            .prepare("SELECT * FROM power_runs WHERE id=?")
            .get<RunRow>(id))!,
        ),
        created: true,
      });
    }
    return values;
  });
}
export async function requestCancel(userId: string, id: string) {
  const run = await getPowerRun(userId, id);
  if (!run) return null;
  await getDb().transaction(async (db) => {
    await db
      .prepare(
        `UPDATE power_runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancel_requested' END,
      updated_at=? WHERE id=? AND user_id=? AND status IN ('queued','running')`,
      )
      .run(new Date().toISOString(), id, userId);
    await db
      .prepare(
        `UPDATE background_jobs SET status='cancelled',updated_at=? WHERE id=? AND status='queued'
      AND EXISTS (SELECT 1 FROM power_runs WHERE id=? AND status='cancelled')`,
      )
      .run(new Date().toISOString(), run.jobId, id);
  });
  return getPowerRun(userId, id);
}
export async function recordProgress(
  id: string,
  token: string,
  phase: string,
  detail: string,
) {
  const db = getDb();
  await db
    .prepare(
      `UPDATE power_runs SET phase=?,updated_at=?,events_json=(events_json::jsonb || ?::jsonb)::text
    WHERE id=? AND lease_token=? AND status IN ('running','cancel_requested')`,
    )
    .run(
      phase,
      new Date().toISOString(),
      JSON.stringify([
        { at: new Date().toISOString(), phase, detail: detail.slice(0, 2000) },
      ]),
      id,
      token,
    );
}
export async function finishPowerRun(
  id: string,
  token: string,
  status: PowerStatus,
  result: PowerResult | null,
  error: string | null,
) {
  return getDb()
    .prepare(
      `UPDATE power_runs SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE ? END,
    phase=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE ? END,
    result_json=CASE WHEN status='cancel_requested' THEN NULL ELSE ? END,
    error=CASE WHEN status='cancel_requested' THEN '计算已取消' ELSE ? END,updated_at=?
    WHERE id=? AND lease_token=? AND status IN ('running','cancel_requested')`,
    )
    .run(
      status,
      status,
      result ? JSON.stringify(asResultBundle(result, status)) : null,
      error,
      new Date().toISOString(),
      id,
      token,
    );
}
export async function recoverPowerRuns() {
  await ensurePowerTables();
  return getDb()
    .prepare(
      `UPDATE power_runs SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'failed' END,
    phase='interrupted',result_json=NULL,error='计算执行已中断，请检查日志后新建运行',updated_at=?
    WHERE status IN ('queued','running','cancel_requested') AND EXISTS (
      SELECT 1 FROM background_jobs j WHERE j.id=power_runs.job_id AND j.status IN ('error','done','cancelled'))`,
    )
    .run(new Date().toISOString());
}
export function artifactNames(run: PowerRun, admin = false) {
  const directory = runDirectory(run.id);
  if (!fs.existsSync(directory)) return [];
  const diagnostics = new Set([
    "input.json",
    "model-input.json",
    "model-input.nc",
    "model-input.xlsx",
    "run-spec.json",
    "diagnosis.json",
    "model.pio.json",
    "events.log",
    "solver.log",
    "mcp.json",
    "tools.json",
    "mcp-stderr.log",
    "report.md",
    "network.json",
    "network.nc",
    "network.xlsx",
    "source.json",
    "source.xlsx",
    "source.nc",
  ]);
  return fs.readdirSync(directory).filter((name) => {
    if (!fs.lstatSync(path.join(directory, name)).isFile()) return false;
    if (
      !admin &&
      [
        "mcp.json",
        "tools.json",
        "mcp-stderr.log",
        "solver.log",
        "network.json",
        "network.nc",
        "network.xlsx",
      ].includes(name)
    )
      return false;
    return (
      diagnostics.has(name) ||
      /^source-[0-9]+\.(raw|dyr|m|json|xlsx|nc|csv)$/.test(name) ||
      (run.result &&
        (/^[a-z-]+\.csv$/.test(name) ||
          [
            "result.json",
            "result-bundle.json",
            "network.json",
            "network.nc",
            "network.xlsx",
          ].includes(name)))
    );
  });
}
