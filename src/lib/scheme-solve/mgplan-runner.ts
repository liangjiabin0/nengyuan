import fs from 'node:fs';
import { enqueueOrRun } from '@/lib/jobs/dispatch';
import { isOptimalSolve } from './esopt';
import {
  getMgplanHealth,
  runMgplanOpenTepes,
  validateMgplanConfig
} from './mgplan';
import {
  hasMgplanOutput,
  mgplanConfigDir,
  mgplanOutputDir,
  prepareMgplanWorkspace,
  seedMgplanFixtureOutput
} from './mgplan-case';
import { summarizeMgplanDir, writeMgplanResultJson } from './mgplan-results';
import {
  appendSchemeEvent,
  getSchemeIdea,
  mergeSchemeStageArtifact,
  refreshSessionAggregate,
  updateSchemeStage
} from './store';
import { readWorkspaceJson } from './workspace';

export function isMgplanIdea(problemClass?: string | null) {
  return problemClass === 'mgplan';
}

async function emit(sessionId: string, ideaId: string, text: string, level: 'info' | 'warn' | 'error' = 'info') {
  await appendSchemeEvent({ sessionId, ideaId, stage: 'solve', text, level });
}

export async function seedMgplanFixtureResult(sessionId: string, ideaId: string) {
  const { outputDir } = prepareMgplanWorkspace(sessionId, ideaId, { seedFixture: true });
  if (!hasMgplanOutput(outputDir)) {
    seedMgplanFixtureOutput(outputDir);
  }
  if (!hasMgplanOutput(outputDir)) {
    throw new Error('没有可用的规划样例输出。');
  }
  const result = summarizeMgplanDir(outputDir, { fixture: true });
  await writeMgplanResultJson(sessionId, ideaId, result);
  return result;
}

export async function runMgplanSolve(
  sessionId: string,
  ideaId: string,
  options?: { allowFixture?: boolean }
) {
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== sessionId) throw new Error('想法不存在。');
  const { configDir, outputDir } = prepareMgplanWorkspace(sessionId, ideaId, { seedFixture: false });
  await updateSchemeStage(ideaId, 'model', { status: 'done', headline: 'sSEP 算例已就绪' });
  await updateSchemeStage(ideaId, 'solve', { status: 'running', headline: '正在检查规划求解环境' });
  emit(sessionId, ideaId, '开始规划求解（openTEPES / sSEP / Gurobi）');
  if (/热电|合成氨|数据中心|直流规划|ThermalPlanning|AmmoniaPlanning|DCPlanning|DataCenterPlanning/i.test(`${idea.title} ${idea.summary} ${idea.decisions}`)) {
    emit(sessionId, ideaId, '原始 skill v1 未开放热电/氨/直流/数据中心 Option，本包也没有对应数据，仍按 sSEP 默认求解', 'warn');
  }

  try {
    validateMgplanConfig(configDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : '算例校验失败。';
    if (!options?.allowFixture) throw new Error(message);
    emit(sessionId, ideaId, `算例校验未通过，回退样例：${message}`, 'warn');
  }

  const health = getMgplanHealth();
  if (health.ok) {
    emit(sessionId, ideaId, 'Gurobi 环境可用，开始重算（可能需要较长时间）');
    if (fs.existsSync(outputDir)) {
      for (const name of fs.readdirSync(outputDir)) {
        fs.rmSync(`${outputDir}/${name}`, { force: true });
      }
    }
    const sidecar = await runMgplanOpenTepes(configDir, outputDir);
    const result = summarizeMgplanDir(outputDir, {
      fixture: false,
      elapsedSeconds: typeof sidecar.elapsedSeconds === 'number' ? sidecar.elapsedSeconds : undefined
    });
    result.status = String(sidecar.status || 'optimal');
    result.ok = true;
    await writeMgplanResultJson(sessionId, ideaId, result);
    if (!isOptimalSolve(result)) {
      await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: '规划求解未达最优', artifactJson: result });
      throw new Error('规划求解未达到最优。');
    }
    await updateSchemeStage(ideaId, 'solve', {
      status: 'done',
      headline: `规划最优目标 ${result.objective}`,
      artifactJson: result
    });
    await mergeSchemeStageArtifact(ideaId, 'design', {
      agentName: 'scheme-designer',
      output: `规划最优目标 ${result.objective}`
    });
    emit(sessionId, ideaId, `规划求解成功，目标值 ${result.objective}`);
    await refreshSessionAggregate(sessionId);
    return result;
  }

  if (!options?.allowFixture) {
    const message = health.error || 'Gurobi / MGPLAN_PYTHON 未就绪，无法重算。';
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: message.slice(0, 80), detail: message });
    emit(sessionId, ideaId, message, 'error');
    throw new Error(message);
  }

  emit(sessionId, ideaId, '求解环境未就绪，已加载 zip 样例结果供展示', 'warn');
  const result = await seedMgplanFixtureResult(sessionId, ideaId);
  await updateSchemeStage(ideaId, 'solve', {
    status: 'done',
    headline: `样例目标 ${result.objective}（未重算）`,
    artifactJson: result
  });
  await mergeSchemeStageArtifact(ideaId, 'design', {
    agentName: 'scheme-designer',
    output: `样例目标 ${result.objective}（未用 Gurobi 重算）`
  });
  await refreshSessionAggregate(sessionId);
  return result;
}

export function readMgplanSolveResult(sessionId: string, ideaId: string) {
  return readWorkspaceJson(sessionId, ideaId, 'result.json');
}

export async function enqueueMgplanSolve(sessionId: string, ideaId: string, allowFixture = false) {
  return enqueueOrRun(
    'mgplan-solve',
    { sessionId, ideaId, allowFixture },
    () => runMgplanSolve(sessionId, ideaId, { allowFixture })
  );
}
