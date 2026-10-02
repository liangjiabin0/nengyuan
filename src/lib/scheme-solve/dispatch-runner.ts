import { enqueueOrRun } from '@/lib/jobs/dispatch';
import { isOptimalSolve } from './esopt';
import { getDispatchHealth, runDispatchTask, validateDispatchSpec, writeDispatchResult } from './dispatch';
import { prepareDispatchWorkspace } from './dispatch-case';
import {
  appendSchemeEvent,
  getSchemeIdea,
  mergeSchemeStageArtifact,
  refreshSessionAggregate,
  updateSchemeStage
} from './store';
import { readWorkspaceJson } from './workspace';

export function isDispatchIdea(problemClass?: string | null) {
  return problemClass === 'dispatch';
}

async function emit(sessionId: string, ideaId: string, text: string, level: 'info' | 'warn' | 'error' = 'info') {
  await appendSchemeEvent({ sessionId, ideaId, stage: 'solve', text, level });
}

export async function runDispatchSolve(sessionId: string, ideaId: string) {
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== sessionId) throw new Error('想法不存在。');
  const prepared = prepareDispatchWorkspace(sessionId, idea);
  await updateSchemeStage(ideaId, 'model', { status: 'done', headline: `${prepared.caseId} RunSpec 已就绪` });
  await updateSchemeStage(ideaId, 'solve', { status: 'running', headline: '正在检查调度优化环境' });
  emit(sessionId, ideaId, `开始电力系统优化调度（${prepared.caseId}）`);
  const health = getDispatchHealth();
  const dryRun = !health.ok;
  if (dryRun) {
    emit(sessionId, ideaId, health.error || 'pandapower 未就绪，改为协议 dry-run', 'warn');
  }
  const validation = validateDispatchSpec(prepared.specPath);
  if (validation.ok === false || validation.valid === false) {
    const message = String(validation.error || validation.message || 'RunSpec validate 未通过');
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: 'RunSpec 未通过校验', detail: message });
    emit(sessionId, ideaId, message, 'error');
    throw new Error(message);
  }
  emit(sessionId, ideaId, 'RunSpec 已通过 validate，开始数值求解');
  const sidecar = await runDispatchTask(prepared.specPath, prepared.outputDir, dryRun);
  const result = writeDispatchResult(sessionId, ideaId, sidecar);
  if (!isOptimalSolve(result)) {
    await updateSchemeStage(ideaId, 'solve', {
      status: 'failed',
      headline: result.fixture ? '调度只完成 dry-run，未做真实潮流' : '调度优化未成功',
      artifactJson: result
    });
    throw new Error(result.fixture ? '调度环境未就绪，dry-run 不能当作最优解。' : '调度优化未成功。');
  }
  await updateSchemeStage(ideaId, 'solve', {
    status: 'done',
    headline: result.fixture ? `调度协议已校验（dry-run）` : `调度目标 ${result.objective ?? '已求出'}`,
    artifactJson: result
  });
  await mergeSchemeStageArtifact(ideaId, 'design', {
    agentName: 'scheme-designer',
    output: result.fixture ? '调度 dry-run 完成' : `调度目标 ${result.objective ?? '已求出'}`
  });
  emit(sessionId, ideaId, result.fixture ? '调度 dry-run 完成' : `调度求解成功，目标值 ${result.objective ?? '见 result.json'}`);
  await refreshSessionAggregate(sessionId);
  return result;
}

export function readDispatchResult(sessionId: string, ideaId: string) {
  return readWorkspaceJson(sessionId, ideaId, 'result.json');
}

export async function enqueueDispatchSolve(sessionId: string, ideaId: string) {
  return enqueueOrRun('dispatch-run', { sessionId, ideaId }, () => runDispatchSolve(sessionId, ideaId));
}
