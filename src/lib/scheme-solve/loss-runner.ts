import fs from 'node:fs';
import path from 'node:path';
import { enqueueOrRun } from '@/lib/jobs/dispatch';
import { isOptimalSolve } from './esopt';
import { getLossHealth, lossDirs, resolveLossRoot, runLossCalculation, writeLossResult } from './loss';
import { parseModelFile } from './model-json';
import { listReadySchemeSolveAttachmentRows } from './attachments';
import {
  appendSchemeEvent,
  getSchemeIdea,
  mergeSchemeStageArtifact,
  refreshSessionAggregate,
  updateSchemeStage
} from './store';
import { listIdeaReportFiles, writeWorkspaceText } from './workspace';

export function isLossIdea(problemClass?: string | null) {
  return problemClass === 'loss';
}

async function emit(sessionId: string, ideaId: string, text: string, level: 'info' | 'warn' | 'error' = 'info') {
  await appendSchemeEvent({ sessionId, ideaId, stage: 'solve', text, level });
}

async function prepareLossInput(sessionId: string, ideaId: string) {
  const { inputPath, outputDir } = lossDirs(sessionId, ideaId);
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  const rows = await listReadySchemeSolveAttachmentRows(sessionId);
  const jsonRow = rows.find((row) => /\.json$/i.test(row.original_name) && row.storage_path && fs.existsSync(row.storage_path));
  if (jsonRow?.storage_path) {
    const raw = fs.readFileSync(jsonRow.storage_path, 'utf8');
    if (raw.includes('dms_def_feeder')) {
      fs.copyFileSync(jsonRow.storage_path, inputPath);
      return { inputPath, outputDir, source: 'attachment' as const };
    }
  }
  const sample = path.join(resolveLossRoot(), 'test_data', 'sample.json');
  if (!fs.existsSync(sample)) throw new Error('缺少线损样例 test_data/sample.json');
  fs.copyFileSync(sample, inputPath);
  return { inputPath, outputDir, source: 'sample' as const };
}

function resolveLossOptions(idea: { title: string; summary: string; decisions?: string | null }, sessionId: string, ideaId: string) {
  const existing = parseModelFile(listIdeaReportFiles(sessionId, ideaId).model).spec || {};
  const text = `${existing.format || ''} ${existing.method || ''} ${idea.title} ${idea.summary} ${idea.decisions || ''}`;
  const format = /json_only|只要json/i.test(text) ? 'json_only' : /summary|只要汇总/i.test(text) ? 'summary' : 'full';
  const methodMatch = text.match(/method["\s:=]*0?(\d{1,2})/i);
  const method = methodMatch ? methodMatch[1]!.padStart(2, '0') : '04';
  const workersMatch = text.match(/workers["\s:=]*(\d+)/i) || text.match(/(\d+)\s*(?:线程|并行|workers)/i);
  const workers = workersMatch ? Number(workersMatch[1]) : undefined;
  const requireAttachment = /必须附件|用户馈线|不要样例|禁止样例/.test(text);
  return { format, method, workers, requireAttachment };
}

export async function runLossSolve(sessionId: string, ideaId: string) {
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== sessionId) throw new Error('想法不存在。');
  const options = resolveLossOptions(idea, sessionId, ideaId);
  const prepared = await prepareLossInput(sessionId, ideaId);
  if (prepared.source === 'sample' && options.requireAttachment) {
    throw new Error('本题要求用户馈线附件，未找到含 dms_def_feeder 的 JSON，拒绝用样例冒充。');
  }
  writeWorkspaceText(
    sessionId,
    ideaId,
    'model.json',
    `${JSON.stringify({
      engine: 'nwxs-loss',
      input: 'loss/input.json',
      format: options.format,
      method: options.method,
      workers: options.workers || null,
      source: prepared.source,
      sample: prepared.source === 'sample'
    }, null, 2)}\n`
  );
  await updateSchemeStage(ideaId, 'model', { status: 'done', headline: prepared.source === 'attachment' ? '已使用附件馈线 JSON' : '已加载线损样例' });
  const health = getLossHealth();
  if (!health.ok) {
    const message = health.error || '线损计算环境未就绪。';
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: message.slice(0, 80), detail: message });
    emit(sessionId, ideaId, message, 'error');
    throw new Error(message);
  }
  await updateSchemeStage(ideaId, 'solve', { status: 'running', headline: `正在计算理论线损（${options.format}/${options.method}）` });
  emit(sessionId, ideaId, `开始南网理论线损计算，format=${options.format} method=${options.method}${options.workers ? ` workers=${options.workers}` : ''}`);
  const sidecar = await runLossCalculation(
    prepared.inputPath,
    prepared.outputDir,
    options.format,
    options.method,
    options.workers
  );
  const result = writeLossResult(sessionId, ideaId, sidecar, { source: prepared.source });
  if (prepared.source === 'sample') {
    emit(sessionId, ideaId, '未找到含 dms_def_feeder 的附件，已用 test_data/sample.json 计算，结果不是用户馈线', 'warn');
  }
  if (!isOptimalSolve(result)) {
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: '线损计算未成功', artifactJson: result });
    throw new Error('线损计算未成功。');
  }
  await updateSchemeStage(ideaId, 'solve', {
    status: 'done',
    headline: `线损率 ${result.lossRate ?? '已求出'}`,
    artifactJson: result
  });
  await mergeSchemeStageArtifact(ideaId, 'design', {
    agentName: 'scheme-designer',
    output: `线损率 ${result.lossRate ?? '见 result.json'}`
  });
  emit(sessionId, ideaId, `线损计算完成，线损率 ${result.lossRate ?? '见 result.json'}`);
  await refreshSessionAggregate(sessionId);
  return result;
}

export async function enqueueLossSolve(sessionId: string, ideaId: string) {
  return enqueueOrRun('loss-calc', { sessionId, ideaId }, () => runLossSolve(sessionId, ideaId));
}
