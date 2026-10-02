import fs from 'node:fs';
import path from 'node:path';
import { enqueueOrRun } from '@/lib/jobs/dispatch';
import { isOptimalSolve } from './esopt';
import {
  getTdmgHealth,
  inspectTdmgCase,
  prepareTdmgTaskPackage,
  runTdmgGeneratedDispatch,
  runTdmgModular,
  runTdmgSolve as runTdmgOpf,
  writeTdmgScenarioTemplate
} from './tdmg';
import {
  prepareTdmgWorkspace,
  tdmgOutputDir,
  wantsTdmgProfiles,
  writeTdmgLoadProfiles
} from './tdmg-case';
import { summarizeTdmgDir, writeTdmgResultJson } from './tdmg-results';
import {
  appendSchemeEvent,
  getSchemeIdea,
  mergeSchemeStageArtifact,
  refreshSessionAggregate,
  updateSchemeStage
} from './store';
import { readWorkspaceJson } from './workspace';

export function isAcopfIdea(problemClass?: string | null) {
  return problemClass === 'acopf';
}

async function emit(sessionId: string, ideaId: string, text: string, level: 'info' | 'warn' | 'error' = 'info') {
  await appendSchemeEvent({ sessionId, ideaId, stage: 'solve', text, level });
}

function emptyOutput(outputDir: string) {
  if (!fs.existsSync(outputDir)) return;
  for (const name of fs.readdirSync(outputDir)) {
    fs.rmSync(path.join(outputDir, name), { recursive: true, force: true });
  }
}

export async function runTdmgSolve(sessionId: string, ideaId: string) {
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== sessionId) throw new Error('想法不存在。');
  const prepared = await prepareTdmgWorkspace(sessionId, idea);
  await updateSchemeStage(ideaId, 'model', { status: 'done', headline: `${prepared.caseName} 算例已就绪` });
  await updateSchemeStage(ideaId, 'solve', { status: 'running', headline: '正在检查 TDMG AC-OPF 环境' });
  emit(sessionId, ideaId, `开始交流最优潮流（${prepared.caseName}，${prepared.source === 'attachment' ? '附件算例' : '内置算例'}）`);

  const health = getTdmgHealth();
  if (!health.ok && !health.vendor) {
    const message = health.error || 'TDMG_PYTHON / scripts/_vendor 未就绪，无法求解交流潮流。';
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: message.slice(0, 80), detail: message });
    emit(sessionId, ideaId, message, 'error');
    throw new Error(message);
  }
  if (!health.ok) {
    emit(sessionId, ideaId, `TDMG 目录探测未通过，继续走内置算例求解：${health.error || 'catalog 无模块列表'}`, 'warn');
  }

  emptyOutput(prepared.outputDir);
  const started = Date.now();
  const sidecarPath = path.join(prepared.inputDir, `${prepared.caseName}.tdmg.json`);
  try {
    inspectTdmgCase(prepared.casePath, sidecarPath);
  } catch (error) {
    emit(
      sessionId,
      ideaId,
      `算例 inspect 未成功，改为直接求解：${error instanceof Error ? error.message : error}`,
      'warn'
    );
  }
  const profilesPath = wantsTdmgProfiles(idea)
    ? writeTdmgLoadProfiles(path.join(prepared.inputDir, `${prepared.caseName}.profiles.json`), /24/.test(`${idea.title} ${idea.summary}`) ? 24 : 4)
    : undefined;
  if (profilesPath) {
    emit(sessionId, ideaId, `已写入独立负荷 profiles：${path.basename(profilesPath)}`);
  }
  let pipelineInput = prepared.casePath;
  if (prepared.mode === 'scenario') {
    const scenarioPath = path.join(prepared.inputDir, `${prepared.caseName}.scenario.json`);
    writeTdmgScenarioTemplate(prepared.casePath, scenarioPath, sidecarPath);
    pipelineInput = scenarioPath;
  }
  let usedGenerated = false;
  try {
    prepareTdmgTaskPackage({
      casePath: pipelineInput,
      outputDir: prepared.outputDir,
      request: idea.title,
      mode: prepared.mode === 'scenario' ? 'scenario' : 'snapshot',
      sidecarPath: fs.existsSync(sidecarPath) ? sidecarPath : undefined,
      profilesPath
    });
    emit(sessionId, ideaId, '已按 skill 协议先生成 TDMG 任务包');
    const generated = path.join(prepared.outputDir, 'generated_dispatch.py');
    if (fs.existsSync(generated)) {
      emit(sessionId, ideaId, '执行任务包 generated_dispatch.py');
      const generatedRun = await runTdmgGeneratedDispatch(prepared.outputDir);
      if (generatedRun.status !== 0) {
        throw new Error(generatedRun.stderr.trim() || generatedRun.stdout.trim() || `generated_dispatch 退出 ${generatedRun.status}`);
      }
      usedGenerated = true;
    }
  } catch (error) {
    emit(
      sessionId,
      ideaId,
      `任务包路径未完成，回退直接求解：${error instanceof Error ? error.message : error}`,
      'warn'
    );
  }
  if (!usedGenerated) {
    emit(
      sessionId,
      ideaId,
      prepared.mode === 'scenario' ? '按输配微/多时段模块化路径求解' : '按单时段 AC-OPF 快路径求解'
    );
    if (prepared.mode === 'scenario') {
      await runTdmgModular(pipelineInput, prepared.outputDir);
    } else {
      await runTdmgOpf(prepared.casePath, prepared.outputDir, { sidecarPath, profilesPath });
    }
  }

  const result = summarizeTdmgDir(prepared.outputDir, {
    caseName: prepared.caseName,
    mode: prepared.mode,
    elapsedSeconds: (Date.now() - started) / 1000
  });
  await writeTdmgResultJson(sessionId, ideaId, result);
  if (!isOptimalSolve(result)) {
    await updateSchemeStage(ideaId, 'solve', { status: 'failed', headline: '交流最优潮流未达最优', artifactJson: result });
    throw new Error('交流最优潮流未达到最优。');
  }
  await updateSchemeStage(ideaId, 'solve', {
    status: 'done',
    headline: `交流最优目标 ${result.objective}`,
    artifactJson: result
  });
  await mergeSchemeStageArtifact(ideaId, 'design', {
    agentName: 'scheme-designer',
    output: `交流最优目标 ${result.objective}`
  });
  emit(sessionId, ideaId, `交流最优潮流成功，目标值 ${result.objective}`);
  await refreshSessionAggregate(sessionId);
  return result;
}

export function readTdmgSolveResult(sessionId: string, ideaId: string) {
  return readWorkspaceJson(sessionId, ideaId, 'result.json');
}

export async function enqueueTdmgSolve(sessionId: string, ideaId: string) {
  return enqueueOrRun(
    'tdmg-solve',
    { sessionId, ideaId },
    () => runTdmgSolve(sessionId, ideaId)
  );
}

export { tdmgOutputDir };
