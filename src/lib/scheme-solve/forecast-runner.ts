import fs from 'node:fs';
import path from 'node:path';
import { enqueueOrRun } from '@/lib/jobs/dispatch';
import { isOptimalSolve } from './esopt';
import {
  forecastDirs,
  getForecastHealth,
  resolveForecastHorizon,
  resolveForecastKind,
  resolveForecastModel,
  resolveForecastVariant,
  runForecastTask,
  writeForecastResult
} from './forecast';
import { schemeSolveWorkspaceRoot } from './workspace';
import { listReadySchemeSolveAttachmentRows } from './attachments';
import {
  appendSchemeEvent,
  getSchemeIdea,
  mergeSchemeStageArtifact,
  refreshSessionAggregate,
  updateSchemeStage
} from './store';
import { writeWorkspaceText } from './workspace';
import type { SchemeIdea } from './types';

export function isForecastIdea(problemClass?: string | null) {
  return problemClass === 'forecast';
}

async function emit(sessionId: string, ideaId: string, text: string, level: 'info' | 'warn' | 'error' = 'info') {
  await appendSchemeEvent({ sessionId, ideaId, stage: 'solve', text, level });
}

function ideaForecastText(idea: SchemeIdea) {
  return `${idea.caseHint || ''} ${idea.title} ${idea.summary} ${idea.decisions || ''}`;
}

export async function runForecastSolve(sessionId: string, ideaId: string) {
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== sessionId) throw new Error('想法不存在。');
  const text = ideaForecastText(idea);
  const kind = resolveForecastKind(text);
  const model = resolveForecastModel(text);
  const horizon = resolveForecastHorizon(text);
  const variant = resolveForecastVariant(text);
  const { outputDir } = forecastDirs(sessionId, ideaId);
  fs.mkdirSync(outputDir, { recursive: true });
  const rows = await listReadySchemeSolveAttachmentRows(sessionId);
  const csv = rows.find((row) => /\.csv$/i.test(row.original_name) && row.storage_path && fs.existsSync(row.storage_path));
  writeWorkspaceText(
    sessionId,
    ideaId,
    'model.json',
    `${JSON.stringify({
      engine: 'pv-wind-load-forecast',
      kind,
      model,
      requestedModel: model,
      action: /训练|train/i.test(text) ? 'train' : 'predict',
      horizon,
      variant
    }, null, 2)}\n`
  );
  const health = getForecastHealth();
  if (!health.ok) {
    const message = health.error || '源荷预测环境未就绪。';
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: message.slice(0, 80), detail: message });
    throw new Error(message);
  }
  await updateSchemeStage(ideaId, 'model', { status: 'done', headline: `${kind}/${model} 预测配置已就绪` });
  await updateSchemeStage(ideaId, 'solve', { status: 'running', headline: `正在预测 ${kind}` });
  emit(sessionId, ideaId, `开始源荷预测（${kind} / ${model}）`);
  const sidecar = await runForecastTask({
    command: /训练|train/i.test(text) ? 'train' : 'predict',
    kind,
    model,
    outputDir,
    data: csv?.storage_path,
    horizon,
    variant
  });
  const result = writeForecastResult(sessionId, ideaId, sidecar);
  const sessionProfile = path.join(schemeSolveWorkspaceRoot(sessionId), 'forecast-profile.csv');
  const sourceProfile = String(result.dispatchProfile || result.profileCsv || '');
  if (sourceProfile && fs.existsSync(sourceProfile)) {
    fs.copyFileSync(sourceProfile, sessionProfile);
  }
  if (!isOptimalSolve(result)) {
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: '预测未成功', artifactJson: result });
    throw new Error('源荷预测未成功。');
  }
  await updateSchemeStage(ideaId, 'solve', {
    status: 'done',
    headline: `${kind} 预测完成`,
    artifactJson: result
  });
  await mergeSchemeStageArtifact(ideaId, 'design', { agentName: 'scheme-designer', output: `${kind} 预测完成` });
  emit(
    sessionId,
    ideaId,
    result.fallback
      ? `${kind} 预测完成（请求 ${result.requestedModel}，实际 ${result.usedModel || result.model}），曲线 ${path.basename(String(result.profileCsv || ''))}`
      : `${kind} 预测完成，曲线 ${path.basename(String(result.profileCsv || ''))}`
  );
  await refreshSessionAggregate(sessionId);
  return result;
}

export async function enqueueForecastSolve(sessionId: string, ideaId: string) {
  return enqueueOrRun('forecast-run', { sessionId, ideaId }, () => runForecastSolve(sessionId, ideaId));
}
