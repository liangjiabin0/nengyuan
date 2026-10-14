import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PaperReviewModelError, probePaperReviewModel, resolvePaperReviewEndpoint } from './llm';
import { getPaperReviewModelConfig, publicPaperReviewModelConfig } from './model-config';
import { resolvePaperReviewPython } from './python';
import { freezeSkillsForTask } from './skills';
import { StageBlockedError, type Ctx, type StageFn } from './stage-kit';
import { stageClassify, stageEvidenceMap, stageParse, stagePreflight } from './stages-prepare';
import { stageDatasetDiscovery, stageEnvironmentCheck, stageReproductionDesign, stageReproductionExecute, stageReproductionVerify } from './stages-repro';
import { stageAcademicReview, stageReportRender } from './stages-review';
import { stagePptBuild, stagePptPlan, stagePptRenderAudit } from './stages-ppt';
import { stageFinalValidation, stagePackaging } from './stages-package';
import {
  appendPaperReviewEvent,
  getPaperReviewTask,
  heartbeatPaperReviewTask,
  isCancelRequested,
  setStageState,
  updatePaperReviewTask
} from './store';
import { PAPER_REVIEW_STAGES, STAGE_LABELS, type ArtifactEntry, type PaperReviewStage } from './types';
import { ensureTaskDirs, sha256File, sha256Text, taskDir, toTaskRelative, validStageCheckpoint, writeStageManifest, readJson } from './workspace';

const STAGES: Record<PaperReviewStage, StageFn> = {
  preflight: stagePreflight,
  parse: stageParse,
  classify: stageClassify,
  evidence_map: stageEvidenceMap,
  dataset_discovery: stageDatasetDiscovery,
  reproduction_design: stageReproductionDesign,
  environment_check: stageEnvironmentCheck,
  reproduction_execute: stageReproductionExecute,
  reproduction_verify: stageReproductionVerify,
  academic_review: stageAcademicReview,
  report_render: stageReportRender,
  ppt_plan: stagePptPlan,
  ppt_build: stagePptBuild,
  ppt_render_audit: stagePptRenderAudit,
  final_validation: stageFinalValidation,
  packaging: stagePackaging
};

/** 这些阶段失败后，任务可以继续做后面的事（例如复现失败照样出评审报告），但最终只能是“部分成果”。 */
const SOFT_STAGES = new Set<PaperReviewStage>(['dataset_discovery', 'reproduction_design', 'environment_check', 'reproduction_execute', 'reproduction_verify', 'ppt_plan', 'ppt_build', 'ppt_render_audit']);
/** 这些阶段依赖前面的软阶段；前面失败时跳过而不是报错。 */
const DEPENDS: Partial<Record<PaperReviewStage, PaperReviewStage[]>> = {
  reproduction_design: ['dataset_discovery'],
  environment_check: ['reproduction_design'],
  reproduction_execute: ['environment_check'],
  ppt_build: ['ppt_plan'],
  ppt_render_audit: ['ppt_build']
};

type Active = { controller: AbortController; promise: Promise<void> };
const store = globalThis as typeof globalThis & { __paperReviewTasks?: Map<string, Active> };
const active = store.__paperReviewTasks || new Map<string, Active>();
store.__paperReviewTasks = active;

export function isPaperReviewRunning(id: string) {
  return active.has(id);
}

function abortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || /取消|aborted/i.test(error.message));
}

/** 收集产物索引，供页面预览和下载。 */
function collectArtifacts(id: string): ArtifactEntry[] {
  const root = taskDir(id);
  const items: ArtifactEntry[] = [];
  const add = (rel: string, kind: ArtifactEntry['kind'], label: string, stage: PaperReviewStage, previewable: boolean) => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return;
    items.push({ id: sha256Text(rel).slice(0, 16), kind, label, path: rel, size: fs.statSync(full).size, sha256: sha256File(full), stage, previewable });
  };
  const list = (dir: string) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)) : []);
  for (const f of list('review')) {
    if (f.endsWith('.docx')) add(`review/${f}`, 'review_docx', f, 'report_render', true);
    if (f === 'review.json') add('review/review.json', 'review_json', '评审 JSON（v8 事实源）', 'academic_review', true);
  }
  for (const f of list('ppt')) if (f.endsWith('.pptx')) add(`ppt/${f}`, 'ppt', f, 'ppt_build', false);
  for (const f of list('ppt/render')) if (/^slide-\d+\.png$/.test(f)) add(`ppt/render/${f}`, 'ppt_render', `PPT 渲染 ${f}`, 'ppt_render_audit', true);
  for (const f of list('reproduction/outputs/figures')) if (/\.(png|jpg|svg)$/i.test(f)) add(`reproduction/outputs/figures/${f}`, 'figure', f, 'reproduction_verify', true);
  for (const f of ['README.md', 'validation.json', 'config.json', 'environment.json', 'evidence_manifest.json']) add(`reproduction/${f}`, 'reproduction', `复现 ${f}`, 'reproduction_verify', true);
  for (const f of list('reproduction/outputs')) if (/\.(csv|json)$/i.test(f)) add(`reproduction/outputs/${f}`, 'reproduction', `复现输出 ${f}`, 'reproduction_execute', true);
  for (const f of list('reproduction/outputs/logs')) add(`reproduction/outputs/logs/${f}`, 'log', `运行日志 ${f}`, 'reproduction_execute', true);
  for (const f of list('package')) if (f.endsWith('.zip')) add(`package/${f}`, 'zip', f, 'packaging', false);
  return items;
}

export async function refreshArtifacts(id: string) {
  await updatePaperReviewTask(id, { artifacts: collectArtifacts(id) });
}

async function runPipeline(id: string, controller: AbortController, opts: { fromStage?: PaperReviewStage; force?: boolean }) {
  const root = ensureTaskDirs(id);
  let task = (await getPaperReviewTask(id))!;
  const log: Ctx['log'] = async (text, level = 'info', data) => {
    await appendPaperReviewEvent(id, { stage: (await getPaperReviewTask(id))?.stage, level, text, data });
  };

  // 冻结技能快照、确定 Python、探测模型（首选不可用且未允许回退时直接停下，绝不静默换模型）
  const skills = freezeSkillsForTask(root);
  const python = resolvePaperReviewPython();
  const probe = await probePaperReviewModel();
  let endpoint;
  try {
    endpoint = resolvePaperReviewEndpoint(probe, { allowStormFallback: task.options.allowStormFallback || getPaperReviewModelConfig().allowStormFallback });
  } catch (error) {
    throw new StageBlockedError(error instanceof Error ? error.message : String(error));
  }
  await updatePaperReviewTask(id, {
    skills,
    model: { requested: publicPaperReviewModelConfig(), resolved: { kind: endpoint.kind, model: endpoint.model, thinking: endpoint.thinking }, probe }
  });
  if (endpoint.kind === 'storm-fallback') await log(`首选模型不可用（${probe.reason}），已按设置回退到 Storm：${endpoint.model}`, 'warn');
  task = (await getPaperReviewTask(id))!;

  const startIndex = opts.fromStage ? PAPER_REVIEW_STAGES.indexOf(opts.fromStage) : 0;
  for (const [index, stage] of PAPER_REVIEW_STAGES.entries()) {
    if (controller.signal.aborted) throw new DOMException('任务已取消', 'AbortError');
    task = (await getPaperReviewTask(id))!;
    const ctx: Ctx = { task, root, signal: controller.signal, python, endpoint, log };
    const cacheKey = sha256Text(JSON.stringify({
      stage,
      paper: task.paperSha256,
      inputs: task.inputs.map((i) => i.sha256),
      skills: Object.fromEntries(Object.entries(skills).map(([k, v]) => [k, v.contentSha256])),
      options: task.options,
      model: endpoint.model,
      thinking: endpoint.thinking,
      previous: PAPER_REVIEW_STAGES.slice(0, index).map((s) => readJson<{ cacheKey?: string }>(path.join(root, 'stages', s, 'manifest.json'), {}).cacheKey || '')
    }));
    // 检查点复用：已通过、缓存键相同、输出文件 hash 未变 → 直接跳过，不再消耗模型。
    // fromStage 之后的阶段（用户要求从这里重跑）和 force 时一律重跑。
    const rerun = opts.force || index >= startIndex && Boolean(opts.fromStage);
    if (!rerun && task.stages[stage]?.status === 'passed' && validStageCheckpoint(id, stage, cacheKey)) continue;
    const deps = DEPENDS[stage] || [];
    if (deps.some((d) => ['failed', 'blocked', 'skipped'].includes(task.stages[d]?.status || ''))) {
      await setStageState(id, stage, { status: 'skipped', detail: `前置阶段未完成，跳过${STAGE_LABELS[stage]}`, finishedAt: new Date().toISOString() });
      continue;
    }
    if (stage === 'packaging') {
      const gates = (await getPaperReviewTask(id))!.gates;
      if (Object.values(gates).some((g) => !g.passed)) {
        await setStageState(id, stage, { status: 'skipped', detail: '质量门禁未全部通过，未生成完整成果包（可手动导出草稿包）', finishedAt: new Date().toISOString() });
        continue;
      }
    }
    await setStageState(id, stage, { status: 'running', startedAt: new Date().toISOString(), detail: STAGE_LABELS[stage], cacheKey });
    await log(`开始：${STAGE_LABELS[stage]}`);
    try {
      const result = await STAGES[stage](ctx);
      const manifest = writeStageManifest(id, stage, cacheKey, result.outputs, result.summary);
      await setStageState(id, stage, { status: 'passed', finishedAt: manifest.finishedAt, manifest: toTaskRelative(id, path.join(root, 'stages', stage, 'manifest.json')), detail: `${STAGE_LABELS[stage]}完成` });
      await refreshArtifacts(id);
    } catch (error) {
      if (abortError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const blocked = error instanceof StageBlockedError || error instanceof PaperReviewModelError;
      await setStageState(id, stage, { status: blocked ? 'blocked' : 'failed', finishedAt: new Date().toISOString(), detail: message.slice(0, 500) });
      await log(`${STAGE_LABELS[stage]}${blocked ? '受阻' : '失败'}：${message}`, 'error');
      if (!SOFT_STAGES.has(stage)) throw error;
    }
  }
}

async function finalize(id: string, error?: unknown) {
  const task = await getPaperReviewTask(id);
  if (!task) return;
  await refreshArtifacts(id);
  const now = new Date().toISOString();
  if (error && abortError(error)) {
    await updatePaperReviewTask(id, { status: 'cancelled', finishedAt: now, error: '用户已取消', cancelRequested: false });
    await appendPaperReviewEvent(id, { level: 'warn', text: '任务已取消' });
    return;
  }
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    const blocked = error instanceof StageBlockedError || error instanceof PaperReviewModelError;
    await updatePaperReviewTask(id, { status: blocked ? 'blocked' : 'failed', finishedAt: now, error: message.slice(0, 2000) });
    await appendPaperReviewEvent(id, { level: 'error', text: `任务${blocked ? '受阻' : '失败'}：${message}` });
    return;
  }
  const allPassed = Object.values(task.gates).length > 0 && Object.values(task.gates).every((g) => g.passed) && task.stages.packaging?.status === 'passed';
  await updatePaperReviewTask(id, { status: allPassed ? 'completed' : 'partial', finishedAt: now, error: null, progress: allPassed ? 100 : task.progress });
  await appendPaperReviewEvent(id, { level: allPassed ? 'success' : 'warn', text: allPassed ? '评审完成：全部质量门禁通过，成果包已生成' : '评审结束，但有阶段未完成，只能导出部分成果' });
}

/** 启动（或从检查点恢复）一个评审任务。同一任务同时只运行一个。 */
export function startPaperReview(id: string, opts: { fromStage?: PaperReviewStage; force?: boolean } = {}) {
  const existing = active.get(id);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const promise = (async () => {
    await updatePaperReviewTask(id, { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, cancelRequested: false });
    const heartbeat = setInterval(() => {
      void (async () => {
        if (await isCancelRequested(id)) controller.abort(new DOMException('用户取消', 'AbortError'));
        else await heartbeatPaperReviewTask(id);
      })().catch(() => undefined);
    }, 5_000);
    try {
      await runPipeline(id, controller, opts);
      await finalize(id);
    } catch (error) {
      await finalize(id, error);
    } finally {
      clearInterval(heartbeat);
      active.delete(id);
    }
  })();
  active.set(id, { controller, promise });
  return promise;
}

export function cancelPaperReviewLocally(id: string) {
  const task = active.get(id);
  task?.controller.abort(new DOMException('用户取消', 'AbortError'));
  return Boolean(task);
}

export function newTaskId() {
  return crypto.randomUUID();
}
