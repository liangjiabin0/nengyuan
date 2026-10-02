import fs from 'node:fs';
import { enqueueOrRun } from '@/lib/jobs/dispatch';
import { isOptimalSolve } from './esopt';
import {
  checkModelicaModel,
  defaultModelicaSource,
  getModelicaHealth,
  inferModelicaSpec,
  modelicaDirs,
  simulateModelica,
  writeModelicaResult
} from './modelica';
import { extractJsonObject } from './model-json';
import {
  appendSchemeEvent,
  getSchemeIdea,
  mergeSchemeStageArtifact,
  refreshSessionAggregate,
  updateSchemeStage
} from './store';
import { readWorkspaceText, writeWorkspaceText } from './workspace';

export function isModelicaIdea(problemClass?: string | null) {
  return problemClass === 'modelica';
}

export function hasGatewayModelicaResult(sessionId: string, ideaId: string) {
  const { resultPath } = modelicaDirs(sessionId, ideaId);
  if (!fs.existsSync(resultPath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>;
    const series = raw.series;
    return Boolean(series && typeof series === 'object' && (raw.available_variables || raw.artifacts));
  } catch {
    return false;
  }
}

async function emit(sessionId: string, ideaId: string, text: string, level: 'info' | 'warn' | 'error' = 'info') {
  await appendSchemeEvent({ sessionId, ideaId, stage: 'solve', text, level });
}

function readModelicaSpec(sessionId: string, ideaId: string, ideaText?: string) {
  const { modelPath } = modelicaDirs(sessionId, ideaId);
  const modelJson = extractJsonObject(readWorkspaceText(sessionId, ideaId, 'model.json')) as Record<string, unknown> | null;
  const inferred = inferModelicaSpec(ideaText);
  if (/^BatterySOC/i.test(inferred.name)) {
    const fallback = defaultModelicaSource(ideaText);
    fs.mkdirSync(modelicaDirs(sessionId, ideaId).dir, { recursive: true });
    fs.writeFileSync(modelPath, fallback.code, 'utf8');
    writeWorkspaceText(
      sessionId,
      ideaId,
      'model.json',
      `${JSON.stringify({
        engine: 'openmodelica',
        modelFile: 'modelica/model.mo',
        model_name: fallback.name,
        outputs: fallback.outputs,
        options: fallback.options
      }, null, 2)}\n`
    );
    const battery = inferModelicaSpec(ideaText).battery;
    return {
      name: fallback.name,
      code: fallback.code,
      parameters: battery
        ? { P: battery.powerKw * 1000, SOC_start: battery.socStart }
        : {},
      outputs: fallback.outputs,
      options: fallback.options
    };
  }
  if (fs.existsSync(modelPath)) {
    const code = fs.readFileSync(modelPath, 'utf8');
    const fromCode = inferModelicaSpec(`${ideaText || ''} ${code}`);
    const name = String(modelJson?.model_name || fromCode.name);
    const outputs = Array.isArray(modelJson?.outputs) && modelJson.outputs.length
      ? (modelJson.outputs as string[])
      : fromCode.outputs;
    return {
      name,
      code,
      parameters: (modelJson?.parameters as Record<string, unknown>) || {},
      outputs,
      options: fromCode.options
    };
  }
  const fallback = defaultModelicaSource(ideaText);
  fs.mkdirSync(modelicaDirs(sessionId, ideaId).dir, { recursive: true });
  fs.writeFileSync(modelPath, fallback.code, 'utf8');
  writeWorkspaceText(
    sessionId,
    ideaId,
    'model.json',
    `${JSON.stringify({
      engine: 'openmodelica',
      modelFile: 'modelica/model.mo',
      model_name: fallback.name,
      outputs: fallback.outputs
    }, null, 2)}\n`
  );
  return {
    name: fallback.name,
    code: fallback.code,
    parameters: {},
    outputs: fallback.outputs,
    options: fallback.options
  };
}

export async function runModelicaSolve(sessionId: string, ideaId: string) {
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== sessionId) throw new Error('想法不存在。');
  const spec = readModelicaSpec(sessionId, ideaId, `${idea.caseHint || ''} ${idea.title} ${idea.summary}`);
  await updateSchemeStage(ideaId, 'model', { status: 'done', headline: `${spec.name} 已落盘` });
  const health = await getModelicaHealth();
  if (!health.ok) {
    const message = health.error || 'OpenModelica 网关未就绪。';
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: message.slice(0, 80), detail: message });
    emit(sessionId, ideaId, message, 'error');
    throw new Error(message);
  }
  await updateSchemeStage(ideaId, 'solve', { status: 'running', headline: '正在 checkModel' });
  emit(sessionId, ideaId, `检查 Modelica 模型 ${spec.name}`);
  const checked = (await checkModelicaModel(spec.name, spec.code)) as { check_ok?: boolean; compiler_messages?: string[] };
  if (checked.check_ok === false) {
    const message = (checked.compiler_messages || []).join('\n') || 'checkModel 失败';
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: '模型检查失败', detail: message });
    throw new Error(message);
  }
  await updateSchemeStage(ideaId, 'solve', { status: 'running', headline: '正在仿真' });
  const simulated = (await simulateModelica({
    modelName: spec.name,
    code: spec.code,
    parameters: spec.parameters,
    outputs: spec.outputs,
    options: spec.options
  })) as Record<string, unknown>;
  const result = writeModelicaResult(sessionId, ideaId, simulated);
  if (!isOptimalSolve(result)) {
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: '仿真未成功', artifactJson: result });
    throw new Error('OpenModelica 仿真未成功。');
  }
  await updateSchemeStage(ideaId, 'solve', { status: 'done', headline: `${spec.name} 仿真完成`, artifactJson: result });
  await mergeSchemeStageArtifact(ideaId, 'design', { agentName: 'scheme-designer', output: `${spec.name} 仿真完成` });
  emit(sessionId, ideaId, `${spec.name} 仿真完成`);
  await refreshSessionAggregate(sessionId);
  return result;
}

export async function enqueueModelicaSolve(sessionId: string, ideaId: string) {
  return enqueueOrRun('modelica-sim', { sessionId, ideaId }, () => runModelicaSolve(sessionId, ideaId));
}
