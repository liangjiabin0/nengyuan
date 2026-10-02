import { runDataImport } from '@/lib/data-import';
import { ingestExcelAndCsv } from '@/lib/excel-ingest';
import { crossLinkKnowledgeGraph } from '@/lib/kg/cross-link';
import { rebuildAliases } from '@/lib/kg/rebuild-aliases';
import { autoMergeHighConfidence } from '@/lib/kg/merge';
import { rebuildSearchIndex } from '@/lib/search-index';
import { startPatentRun } from '@/lib/patent-generation/runner';
import { startGridGuideTask } from '@/lib/grid-guide/runner';
import { startSchemeResearch } from '@/lib/scheme-solve/orchestrator';
import { startPptVoiceBuild } from '@/lib/ppt-voice/orchestrator';
import { runMgplanSolve } from '@/lib/scheme-solve/mgplan-runner';
import { runTdmgSolve } from '@/lib/scheme-solve/tdmg-runner';
import { runDispatchSolve } from '@/lib/scheme-solve/dispatch-runner';
import { runLossSolve } from '@/lib/scheme-solve/loss-runner';
import { runModelicaSolve } from '@/lib/scheme-solve/modelica-runner';
import { runForecastSolve } from '@/lib/scheme-solve/forecast-runner';
import type { FastImportOptions } from '@/lib/fast-import';
import type { BackgroundJob, JobType } from './types';
import { updateJobProgress } from './queue';

export type JobHandler = (job: BackgroundJob) => Promise<unknown>;

function startHeartbeat(intervalMs: number, work: () => Promise<void>) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void work()
      .catch((error) => console.error('[jobs] heartbeat failed', error))
      .finally(() => { running = false; });
  }, intervalMs);
  return () => clearInterval(timer);
}

async function handleDataImport(job: BackgroundJob) {
  const rootDir = typeof job.payload.rootDir === 'string' ? job.payload.rootDir : undefined;
  const options = (job.payload.options as FastImportOptions | undefined) ?? {};
  await updateJobProgress(job.id, { phase: 'importing' });
  return runDataImport(rootDir, options);
}

async function handleExcelIngest(_job: BackgroundJob) {
  return ingestExcelAndCsv();
}

async function handleGraphRebuild(job: BackgroundJob) {
  const mode = String(job.payload.mode || 'full');
  if (mode === 'aliases') return rebuildAliases();
  if (mode === 'merge') return autoMergeHighConfidence();
  return crossLinkKnowledgeGraph();
}

async function handleReindex(job: BackgroundJob) {
  const skipCrossLink = job.payload.crossLink === false;
  const crossLink = skipCrossLink ? null : await crossLinkKnowledgeGraph();
  const result = await rebuildSearchIndex();
  return { crossLink, result };
}

async function handlePatentRun(job: BackgroundJob) {
  const runId = String(job.payload.runId || '');
  const projectId = String(job.payload.projectId || '');
  if (!runId || !projectId) throw new Error('patent-run payload requires runId and projectId');
  await startPatentRun(runId, projectId);
  return { runId, projectId };
}

async function handleGridGuideTask(job: BackgroundJob) {
  const projectId = String(job.payload.projectId || '');
  if (!projectId) throw new Error('grid-guide-task payload requires projectId');
  const instruction = String(job.payload.instruction || '');
  const selection =
    typeof job.payload.selection === 'string' ? job.payload.selection : undefined;
  const started = Date.now();
  const stopHeartbeat = startHeartbeat(20_000, async () => {
    const minutes = Math.max(1, Math.round((Date.now() - started) / 60_000));
    await updateJobProgress(job.id, { phase: 'generating', projectId, minutes });
  });
  try {
    await updateJobProgress(job.id, { phase: 'starting', projectId });
    await startGridGuideTask({ projectId, instruction, selection });
    return { projectId };
  } finally {
    stopHeartbeat();
  }
}

async function handleSchemeResearch(job: BackgroundJob) {
  const sessionId = String(job.payload.sessionId || '');
  if (!sessionId) throw new Error('scheme-research payload requires sessionId');
  const ideaIds = Array.isArray(job.payload.ideaIds)
    ? job.payload.ideaIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
    : [];
  const started = Date.now();
  const stopHeartbeat = startHeartbeat(20_000, async () => {
    const minutes = Math.max(1, Math.round((Date.now() - started) / 60_000));
    await updateJobProgress(job.id, { phase: 'researching', sessionId, minutes });
  });
  try {
    await updateJobProgress(job.id, { phase: 'starting', sessionId });
    await startSchemeResearch(sessionId, ideaIds.length ? ideaIds : undefined);
    return { sessionId, ideaIds };
  } finally {
    stopHeartbeat();
  }
}

async function handleMgplanSolve(job: BackgroundJob) {
  const sessionId = String(job.payload.sessionId || '');
  const ideaId = String(job.payload.ideaId || '');
  if (!sessionId || !ideaId) throw new Error('mgplan-solve payload requires sessionId and ideaId');
  const stopHeartbeat = startHeartbeat(30_000, async () => {
    await updateJobProgress(job.id, { phase: 'solving', ideaId });
  });
  try {
    await updateJobProgress(job.id, { phase: 'starting', ideaId });
    return await runMgplanSolve(sessionId, ideaId, { allowFixture: job.payload.allowFixture === true });
  } finally {
    stopHeartbeat();
  }
}

async function handleTdmgSolve(job: BackgroundJob) {
  const sessionId = String(job.payload.sessionId || '');
  const ideaId = String(job.payload.ideaId || '');
  if (!sessionId || !ideaId) throw new Error('tdmg-solve payload requires sessionId and ideaId');
  const stopHeartbeat = startHeartbeat(30_000, async () => {
    await updateJobProgress(job.id, { phase: 'solving', ideaId });
  });
  try {
    await updateJobProgress(job.id, { phase: 'starting', ideaId });
    return await runTdmgSolve(sessionId, ideaId);
  } finally {
    stopHeartbeat();
  }
}

async function handlePptVoiceBuild(job: BackgroundJob) {
  const projectId = String(job.payload.projectId || '');
  if (!projectId) throw new Error('ppt-voice-build payload requires projectId');
  await startPptVoiceBuild(projectId, job.payload.skipEmpty === true);
  return { projectId };
}

const HANDLERS: Record<JobType, JobHandler> = {
  'data-import': handleDataImport,
  'excel-ingest': handleExcelIngest,
  'graph-rebuild': handleGraphRebuild,
  reindex: handleReindex,
  'patent-run': handlePatentRun,
  'grid-guide-task': handleGridGuideTask,
  'scheme-research': handleSchemeResearch,
  'ppt-voice-build': handlePptVoiceBuild,
  'mgplan-solve': handleMgplanSolve,
  'tdmg-solve': handleTdmgSolve,
  'dispatch-run': async (job) => {
    const sessionId = String(job.payload.sessionId || '');
    const ideaId = String(job.payload.ideaId || '');
    if (!sessionId || !ideaId) throw new Error('dispatch-run payload requires sessionId and ideaId');
    return runDispatchSolve(sessionId, ideaId);
  },
  'loss-calc': async (job) => {
    const sessionId = String(job.payload.sessionId || '');
    const ideaId = String(job.payload.ideaId || '');
    if (!sessionId || !ideaId) throw new Error('loss-calc payload requires sessionId and ideaId');
    return runLossSolve(sessionId, ideaId);
  },
  'modelica-sim': async (job) => {
    const sessionId = String(job.payload.sessionId || '');
    const ideaId = String(job.payload.ideaId || '');
    if (!sessionId || !ideaId) throw new Error('modelica-sim payload requires sessionId and ideaId');
    return runModelicaSolve(sessionId, ideaId);
  },
  'forecast-run': async (job) => {
    const sessionId = String(job.payload.sessionId || '');
    const ideaId = String(job.payload.ideaId || '');
    if (!sessionId || !ideaId) throw new Error('forecast-run payload requires sessionId and ideaId');
    return runForecastSolve(sessionId, ideaId);
  }
};

export function getJobHandler(type: JobType): JobHandler {
  const handler = HANDLERS[type];
  if (!handler) throw new Error(`No handler for job type: ${type}`);
  return handler;
}

export async function executeJob(job: BackgroundJob): Promise<unknown> {
  return getJobHandler(job.type)(job);
}
