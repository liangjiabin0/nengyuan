import fs from 'node:fs';
import path from 'node:path';
import {
  runSchemeDesigner,
  runSchemeReviewer,
  runSchemeWriter
} from '@/lib/opencode/scheme-solve';
import type { RuntimeAgentStep } from '@/lib/opencode/types';
import { enqueueOrRun } from '@/lib/jobs/dispatch';
import { hasActiveSchemeResearchJob, isJobQueueEnabled } from '@/lib/jobs/queue';
import { listReadySchemeSolveAttachmentRows } from './attachments';
import { formatRuntimeStep } from './agent-trace';
import { isMaximizeGoal } from './best-idea';
import {
  SCHEME_DESIGNER_AGENT,
  SCHEME_DESIGNER_TIMEOUT_MS,
  SCHEME_RESEARCH_CONCURRENCY,
  SCHEME_REVIEWER_AGENT,
  SCHEME_WRITER_AGENT
} from './constants';
import {
  compareEsoptReference,
  inspectEsoptCase,
  isOptimalSolve,
  isTimedMpsSolve,
  solveDcopfCase,
  hasUsableMpsValues,
  solveIncrementalModel,
  solveModelJsonFile,
  solveMpsFileAsync
} from './esopt';
import { prepareEsoptMpsWorkspace, resolveEsoptModelFile } from './esopt-mps';
import { prepareMgplanWorkspace } from './mgplan-case';
import { isMgplanIdea, runMgplanSolve } from './mgplan-runner';
import { inferTdmgCase, prepareTdmgWorkspace, writeTdmgModelJson } from './tdmg-case';
import { isAcopfIdea, runTdmgSolve } from './tdmg-runner';
import { isDispatchIdea, runDispatchSolve } from './dispatch-runner';
import { prepareDispatchWorkspace } from './dispatch-case';
import { isLossIdea, runLossSolve } from './loss-runner';
import { hasGatewayModelicaResult, isModelicaIdea, runModelicaSolve } from './modelica-runner';
import { isForecastIdea, runForecastSolve } from './forecast-runner';
import {
  fallbackModelJson,
  inferExplicitLinearModel,
  inferEsoptCase,
  normalizeEsoptCase,
  parseModelFile,
  stringifyModel
} from './model-json';
import {
  appendSchemeEvent,
  getSchemeIdea,
  getSchemeSession,
  listSchemeIdeas,
  listSchemeStages,
  listSolvableIdeaIds,
  mergeSchemeStageArtifact,
  refreshSessionAggregate,
  setSchemeSessionProgress,
  setSchemeSessionStatus,
  updateSchemeStage
} from './store';
import type { SchemeIdea, SchemeStageKey } from './types';
import {
  listIdeaReportFiles,
  prepareSchemeIdeaWorkspace,
  readWorkspaceJson,
  schemeIdeaDirectory,
  writeWorkspaceText
} from './workspace';

const globalTasks = globalThis as typeof globalThis & {
  __schemeResearch?: Map<string, Promise<void>>;
  __schemeIdeaLocks?: Set<string>;
};

const tasks = globalTasks.__schemeResearch || new Map<string, Promise<void>>();
globalTasks.__schemeResearch = tasks;
const ideaLocks = globalTasks.__schemeIdeaLocks || new Set<string>();
globalTasks.__schemeIdeaLocks = ideaLocks;

async function emit(
  sessionId: string,
  ideaId: string,
  stage: SchemeStageKey,
  text: string,
  level: 'info' | 'warn' | 'error' | 'thought' = 'info'
) {
  await appendSchemeEvent({ sessionId, ideaId, stage, text, level });
}

async function mark(
  ideaId: string,
  key: SchemeStageKey,
  status: 'idle' | 'running' | 'done' | 'failed',
  headline: string,
  detail?: string,
  artifactJson?: unknown
) {
  await updateSchemeStage(ideaId, key, { status, headline, detail, artifactJson });
}

function parseAgentUid(detail: string) {
  return detail.match(/ses_[A-Za-z0-9]+/)?.[0] || '';
}

async function rememberAgentUid(ideaId: string, key: SchemeStageKey, agentName: string, detail: string) {
  const uid = parseAgentUid(detail);
  if (!uid) return;
  await mergeSchemeStageArtifact(ideaId, key, { agentName, agentUid: uid });
}

const persistedStepSig = new Map<string, string>();

async function applyAgentStep(
  sessionId: string,
  ideaId: string,
  key: SchemeStageKey,
  agentName: string,
  step: RuntimeAgentStep,
  lane?: string
) {
  const formatted = formatRuntimeStep(step, lane);
  if (!formatted) return;
  const output = step.type === 'public_text' || step.type === 'synthesis'
    ? step.content.trim().slice(0, 2000)
    : undefined;
  await mergeSchemeStageArtifact(ideaId, key, {
    agentName,
    output,
    steps: [formatted.stored]
  });
  const sigKey = `${ideaId}:${key}:${lane || ''}:${step.type}:${step.step}`;
  const sig = formatted.eventText.slice(0, 96);
  if (persistedStepSig.get(sigKey) === sig) return;
  persistedStepSig.set(sigKey, sig);
  const level = step.type === 'thought' || step.type === 'plan'
    ? 'thought'
    : step.type === 'public_text' || step.type === 'synthesis'
      ? 'output'
      : 'info';
  await appendSchemeEvent({ sessionId, ideaId, stage: key, level, text: formatted.eventText });
}

function writeFallbackDesign(sessionId: string, idea: SchemeIdea) {
  const body = [
    `# ${idea.title}`,
    '',
    idea.summary,
    '',
    `问题类型：${idea.problemClass || 'unknown'}`,
    `决策：${idea.decisions || ''}`,
    `约束：${idea.limits || ''}`,
    `目标：${idea.goal || ''}`,
    idea.caseHint ? `算例：${idea.caseHint}` : '',
    '',
    idea.whySolvable
      || (isMgplanIdea(idea.problemClass)
        ? '该想法走 openTEPES 多能规划（sSEP 算例）。'
        : isAcopfIdea(idea.problemClass)
          ? '该想法走 TDMG / PYPOWER 交流最优潮流。'
          : isDispatchIdea(idea.problemClass)
            ? '该想法走电力系统优化调度 Skill（RunSpec + pandapower/Pyomo）。'
            : isLossIdea(idea.problemClass)
              ? '该想法走南网理论线损计算（17 张结果表）。'
              : isModelicaIdea(idea.problemClass)
                ? '该想法走 OpenModelica 仿真网关。'
                : isForecastIdea(idea.problemClass)
                  ? '该想法走光伏/风电/负荷预测建模。'
          : '该想法已通过头脑风暴判定为 ESOPT 可解的线性/MIP/DCOPF。'),
    '',
    '（编排器按想法字段写入，供建模、审查与撰写引用。）'
  ]
    .filter((line) => line !== '')
    .join('\n');
  writeWorkspaceText(sessionId, idea.id, 'DESIGN.md', `${body}\n`);
}

function resultSummary(result: unknown) {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  return {
    status: record.termination_status ?? record.terminationStatus ?? record.status ?? 'unknown',
    objective: record.objective ?? record.objective_value ?? '未给出'
  };
}

function honestyLines(idea: SchemeIdea, result: unknown) {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const lines: string[] = [];
  if (idea.problemClass === 'loss' && (record.source === 'sample' || record.sample === true)) {
    lines.push('- 数据来源：test_data/sample.json 样例馈线，不是用户上传馈线。');
  }
  if (idea.problemClass === 'forecast') {
    const requested = record.requestedModel || record.model;
    const used = record.usedModel || record.model;
    if (record.fallback === true || (requested && used && requested !== used)) {
      lines.push(`- 模型回退：请求 ${String(requested)}，实际 ${String(used)}，不能写成深度学习已跑通。`);
    }
  }
  if (record.mode === 'mps' || record.mode === 'lp' || record.modelFile) {
    lines.push(`- 模型来源：附件 ${String(record.sourceName || record.modelFile)}，由 HiGHS 直接读取，未改写成 variables JSON。`);
  }
  return lines;
}

function writeFallbackReviews(sessionId: string, idea: SchemeIdea, result: unknown) {
  const files = listIdeaReportFiles(sessionId, idea.id);
  const { status, objective } = resultSummary(result);
  const honesty = honestyLines(idea, result);
  if (!files.reviewSmall) {
    writeWorkspaceText(
      sessionId,
      idea.id,
      'review-small.md',
      [
        '# 形式校核（编排器回退）',
        '',
        `- 问题类型：${idea.problemClass || 'unknown'}`,
        idea.problemClass === 'mgplan'
          ? `- 求解状态：${status}（openTEPES 以 status=optimal 为最优）`
          : idea.problemClass === 'acopf'
            ? `- 求解状态：${status}（TDMG AC-OPF 以 status=optimal 为最优）`
            : ['dispatch', 'loss', 'modelica', 'forecast'].includes(String(idea.problemClass))
              ? `- 求解状态：${status}（${idea.problemClass} 以 success 为成功）`
            : `- termination_status：${status}（7 为最优）`,
        `- 目标值：${objective}`,
        `- 模型文件：${files.model ? '已存在' : '缺失'}`,
        `- 结果文件：${files.result ? '已存在' : '缺失'}`,
        ...honesty,
        '',
        isOptimalSolve(result)
          ? '形式校核通过：求解器报告最优，目标值已写出。'
          : '形式校核未通过：求解器未报告最优。'
      ].join('\n') + '\n'
    );
    emit(sessionId, idea.id, 'review', '小模型审查未落盘，已按结果补写形式校核', 'warn');
  }
  if (!files.reviewLarge) {
    writeWorkspaceText(
      sessionId,
      idea.id,
      'review-large.md',
      [
        '# 工程审查（编排器回退）',
        '',
        `想法：${idea.title}`,
        idea.summary,
        '',
        `决策：${idea.decisions || ''}`,
        `约束：${idea.limits || ''}`,
        `目标：${idea.goal || ''}`,
        '',
        idea.problemClass === 'mgplan'
          ? `规划目标值 ${objective}，status=${status}。`
          : idea.problemClass === 'acopf'
            ? `交流最优潮流目标值 ${objective}，status=${status}。`
            : ['dispatch', 'loss', 'modelica', 'forecast'].includes(String(idea.problemClass))
              ? `求解目标值 ${objective}，status=${status}。`
              : `求解目标值 ${objective}，termination_status=${status}。`,
        ...honesty,
        '审查 Agent 未落盘，本文件仅对照想法字段与 result.json 做摘要，供撰写引用。'
      ].join('\n') + '\n'
    );
    emit(sessionId, idea.id, 'review', '大模型审查未落盘，已按结果补写工程审查', 'warn');
  }
}

function writeFallbackReport(sessionId: string, idea: SchemeIdea, result: unknown) {
  const files = listIdeaReportFiles(sessionId, idea.id);
  if (files.report) return;
  const { status, objective } = resultSummary(result);
  const honesty = honestyLines(idea, result);
  writeWorkspaceText(
    sessionId,
    idea.id,
    'REPORT.md',
    [
      `# ${idea.title}`,
      '',
      '## 问题',
      idea.summary,
      '',
      '## 模型',
      files.design || `${idea.decisions}\n\n${idea.limits}\n\n${idea.goal}`,
      '',
      '## 求解结果',
      idea.problemClass === 'mgplan' || idea.problemClass === 'acopf' || ['dispatch', 'loss', 'modelica', 'forecast'].includes(String(idea.problemClass))
        ? `- 求解状态：${status}`
        : `- termination_status：${status}`,
      `- 目标值：${objective}`,
      ...honesty,
      '',
      '## 校核记录',
      files.reviewSmall || '（无小模型审查）',
      '',
      files.reviewLarge || '（无大模型审查）',
      '',
      '（撰写 Agent 未落盘，编排器按已有产物生成报告草稿。）'
    ].join('\n') + '\n'
  );
  emit(sessionId, idea.id, 'write', '撰写 Agent 未写出 REPORT.md，已按产物补写报告草稿', 'warn');
}

function writeModelFile(sessionId: string, ideaId: string, spec: Record<string, unknown>) {
  writeWorkspaceText(sessionId, ideaId, 'model.json', stringifyModel(spec));
}

async function ensureDesignArtifacts(sessionId: string, idea: SchemeIdea) {
  if (isMgplanIdea(idea.problemClass)) {
    prepareMgplanWorkspace(sessionId, idea.id, { seedFixture: true });
  }
  if (isAcopfIdea(idea.problemClass)) {
    writeTdmgModelJson(sessionId, idea.id, {
      case: inferTdmgCase(`${idea.caseHint || ''} ${idea.title} ${idea.summary}`),
      mode: /输配微|日前|日内|实时|储能|SOC|多时段/i.test(`${idea.title} ${idea.summary} ${idea.decisions} ${idea.limits}`)
        ? 'scenario'
        : 'snapshot'
    });
  }
  if (isDispatchIdea(idea.problemClass)) {
    prepareDispatchWorkspace(sessionId, idea);
  }
  return finalizeDesignArtifacts(sessionId, idea);
}

async function finalizeDesignArtifacts(sessionId: string, idea: SchemeIdea) {
  const mps = await prepareEsoptMpsWorkspace(sessionId, idea);
  const files = listIdeaReportFiles(sessionId, idea.id);
  if (!files.design) {
    writeFallbackDesign(sessionId, idea);
  }
  if (mps && mps.kind === 'mps') {
    emit(sessionId, idea.id, 'model', `已识别附件 ${String(mps.spec?.sourceName || mps.spec?.modelFile || 'MPS')}，交给 ESOPT/HiGHS 直接求解`);
    return mps;
  }
  const explicit = (idea.problemClass === 'lp' || idea.problemClass === 'mip')
    ? inferExplicitLinearModel(`${idea.summary} ${idea.decisions} ${idea.limits} ${idea.goal}`, idea.problemClass)
    : null;
  if (explicit) {
    writeModelFile(sessionId, idea.id, explicit);
    emit(sessionId, idea.id, 'model', '已按题目中的变量、约束和目标写入 model.json');
    return parseModelFile(stringifyModel(explicit));
  }
  const parsed = parseModelFile(files.model);
  if (parsed.kind !== 'invalid' && parsed.spec) {
    if (files.model.trim() !== stringifyModel(parsed.spec).trim()) {
      writeModelFile(sessionId, idea.id, parsed.spec);
    }
    return parsed;
  }
  const model = fallbackModelJson(idea);
  if (model) {
    writeModelFile(sessionId, idea.id, model);
    emit(sessionId, idea.id, 'model', parsed.reason
      ? `已修复无效 model.json（${parsed.reason}）`
      : '已按问题模板写入 model.json');
    return parseModelFile(stringifyModel(model));
  }
  return parsed;
}

function ideaMentionsPslp(idea: SchemeIdea) {
  return /pslp/i.test(`${idea.title} ${idea.summary} ${idea.decisions} ${idea.limits} ${idea.goal}`);
}

function ideaMentionsIncremental(idea: SchemeIdea, spec: Record<string, unknown> | null) {
  if (spec?.incremental === true) return true;
  return /增量建模|model-new|add-var|incremental/i.test(`${idea.title} ${idea.summary} ${idea.decisions}`);
}

async function solveParsedModel(sessionId: string, idea: SchemeIdea, parsed: ReturnType<typeof parseModelFile>, modelPath: string) {
  if (parsed.kind === 'dcopf-case' && parsed.caseName) {
    const pslp = ideaMentionsPslp(idea);
    emit(sessionId, idea.id, 'solve', `按标准算例求解 ${parsed.caseName}${pslp ? '（请求 PSLP）' : ''}`);
    try {
      const inspected = inspectEsoptCase(parsed.caseName);
      emit(
        sessionId,
        idea.id,
        'solve',
        `inspect ${parsed.caseName}：节点 ${inspected.buses ?? '?'}，支路 ${inspected.branches ?? '?'}，机组 ${inspected.generators ?? '?'}`
      );
    } catch (error) {
      emit(sessionId, idea.id, 'solve', `inspect 未成功：${error instanceof Error ? error.message : error}`, 'warn');
    }
    const solved = solveDcopfCase(parsed.caseName, { pslp }) as Record<string, unknown>;
    const objective = Number(solved.objective);
    if (Number.isFinite(objective)) {
      try {
        const compared = compareEsoptReference(parsed.caseName, objective);
        solved.referenceCompare = compared;
        emit(
          sessionId,
          idea.id,
          'solve',
          compared.match_highs
            ? `目标 ${objective} 与 HiGHS 参考日志一致`
            : `已对照参考日志（match_highs=${String(compared.match_highs)}）`
        );
      } catch (error) {
        emit(sessionId, idea.id, 'solve', `compare 未成功：${error instanceof Error ? error.message : error}`, 'warn');
      }
    }
    if (pslp) solved.requestedPslp = true;
    return solved;
  }
  if (parsed.kind === 'mps') {
    const filePath = resolveEsoptModelFile(sessionId, idea.id, parsed.spec);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error('未找到可求解的 MPS/LP 文件。');
    }
    await emit(
      sessionId,
      idea.id,
      'solve',
      `附件已经是 MPS/LP，不再重写模型，直接交给 HiGHS 读 ${path.basename(filePath)}。大文件可能要跑几十分钟，结果会在求解结束后再写。`,
      'thought'
    );
    await setSchemeSessionProgress(sessionId, 55, `HiGHS 正在求解 ${path.basename(filePath)}，时限 60 分钟`);
    const solved = await solveMpsFileAsync(filePath) as Record<string, unknown>;
    solved.mode = parsed.spec?.mode || (filePath.toLowerCase().endsWith('.lp') ? 'lp' : 'mps');
    solved.modelFile = parsed.spec?.modelFile || path.basename(filePath);
    solved.sourceName = parsed.spec?.sourceName || path.basename(filePath);
    return solved;
  }
  if (parsed.kind === 'linear') {
    if (ideaMentionsIncremental(idea, parsed.spec) && parsed.spec) {
      const sessionPath = path.join(schemeIdeaDirectory(sessionId, idea.id), 'esopt-session.json');
      emit(sessionId, idea.id, 'solve', '按 ESOPT 增量建模会话求解（model-new / add-var / optimize）');
      return solveIncrementalModel(parsed.spec, sessionPath);
    }
    emit(sessionId, idea.id, 'solve', '用 ESOPT CLI 求解线性模型');
    return solveModelJsonFile(modelPath);
  }
  throw new Error(parsed.reason || 'model.json 无法求解。');
}

async function ensureSolveResult(sessionId: string, idea: SchemeIdea) {
  if (isMgplanIdea(idea.problemClass)) {
    const existing = readWorkspaceJson(sessionId, idea.id, 'result.json');
    if (isOptimalSolve(existing)) return existing;
    emit(sessionId, idea.id, 'solve', '启动 openTEPES 规划求解（无 Gurobi 时失败，不用样例冒充最优）');
    return runMgplanSolve(sessionId, idea.id, { allowFixture: false });
  }
  if (isAcopfIdea(idea.problemClass)) {
    const existing = readWorkspaceJson(sessionId, idea.id, 'result.json');
    if (isOptimalSolve(existing)) return existing;
    emit(sessionId, idea.id, 'solve', '启动 TDMG / PYPOWER 交流最优潮流');
    return runTdmgSolve(sessionId, idea.id);
  }
  if (isDispatchIdea(idea.problemClass)) {
    const existing = readWorkspaceJson(sessionId, idea.id, 'result.json');
    if (isOptimalSolve(existing)) return existing;
    emit(sessionId, idea.id, 'solve', '启动电力系统优化调度 Skill');
    return runDispatchSolve(sessionId, idea.id);
  }
  if (isLossIdea(idea.problemClass)) {
    const existing = readWorkspaceJson(sessionId, idea.id, 'result.json');
    if (isOptimalSolve(existing)) return existing;
    emit(sessionId, idea.id, 'solve', '启动南网理论线损计算');
    return runLossSolve(sessionId, idea.id);
  }
  if (isModelicaIdea(idea.problemClass)) {
    const existing = readWorkspaceJson(sessionId, idea.id, 'result.json');
    if (isOptimalSolve(existing) && hasGatewayModelicaResult(sessionId, idea.id)) return existing;
    emit(sessionId, idea.id, 'solve', '启动 OpenModelica 仿真网关');
    return runModelicaSolve(sessionId, idea.id);
  }
  if (isForecastIdea(idea.problemClass)) {
    const existing = readWorkspaceJson(sessionId, idea.id, 'result.json');
    if (isOptimalSolve(existing)) return existing;
    emit(sessionId, idea.id, 'solve', '启动源荷预测');
    return runForecastSolve(sessionId, idea.id);
  }
  const dir = schemeIdeaDirectory(sessionId, idea.id);
  const resultPath = path.join(dir, 'result.json');
  if (fs.existsSync(resultPath)) {
    const existing = readWorkspaceJson(sessionId, idea.id, 'result.json');
    const mode = existing && typeof existing === 'object'
      ? String((existing as Record<string, unknown>).mode || (existing as Record<string, unknown>).modelFile || '')
      : '';
    const mpsLike = /\b(mps|lp)\b|\.(mps|lp)$/i.test(mode);
    if (existing && (!mpsLike || hasUsableMpsValues(existing))) return existing;
  }
  const modelPath = path.join(dir, 'model.json');
  let parsed = parseModelFile(listIdeaReportFiles(sessionId, idea.id).model);
  if (parsed.kind === 'invalid') {
    parsed = await ensureDesignArtifacts(sessionId, idea);
  }
  const attempts: Array<() => Promise<unknown> | unknown> = [];
  if (parsed.kind !== 'invalid') {
    attempts.push(() => solveParsedModel(sessionId, idea, parsed, modelPath));
  }
  if (parsed.kind === 'mps') {
    let lastError = parsed.reason || 'MPS/LP 求解失败。';
    for (const attempt of attempts) {
      try {
        const solved = await attempt();
        writeWorkspaceText(sessionId, idea.id, 'result.json', `${JSON.stringify(solved, null, 2)}\n`);
        return solved;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'MPS/LP 求解失败。';
      }
    }
    throw new Error(lastError);
  }
  const hintedCase = normalizeEsoptCase(idea.caseHint)
    || inferEsoptCase(`${idea.caseHint || ''} ${idea.title} ${idea.summary}`);
  if (hintedCase && hintedCase !== parsed.caseName) {
    attempts.push(() => {
      emit(sessionId, idea.id, 'solve', `改按算例提示求解 ${hintedCase}`);
      return solveDcopfCase(hintedCase);
    });
  }
  const fallback = fallbackModelJson(idea);
  if (fallback) {
    attempts.push(() => {
      writeModelFile(sessionId, idea.id, fallback);
      emit(sessionId, idea.id, 'solve', '已换用问题模板重新求解');
      return solveParsedModel(sessionId, idea, parseModelFile(stringifyModel(fallback)), modelPath);
    });
  }

  let lastError = parsed.reason || '没有可求解的 model.json。';
  for (const attempt of attempts) {
    try {
      const solved = await attempt();
      writeWorkspaceText(sessionId, idea.id, 'result.json', `${JSON.stringify(solved, null, 2)}\n`);
      return solved;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'CLI 回退求解失败。';
      if (/variables array|must contain an objective|dictionary update sequence|constraints/i.test(lastError)) {
        lastError = '模型文件无法求解，已尝试按算例或模板回退。';
        continue;
      }
    }
  }
  throw new Error(lastError);
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const pending = new Set<Promise<void>>();
  for (const item of items) {
    const task = worker(item).finally(() => pending.delete(task));
    pending.add(task);
    if (pending.size >= limit) await Promise.race(pending);
  }
  await Promise.all(pending);
}

async function markSolveSuccess(sessionId: string, idea: SchemeIdea, result: unknown) {
  const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const objective = record.objective ?? record.objective_value ?? record.lossRate;
  const engine = String(record.engine || '');
  const headline = engine === 'nwxs-loss'
    ? `线损率 ${record.lossRate ?? '已求出'}${record.source === 'sample' || record.sample === true ? '（样例馈线）' : ''}`
    : engine === 'pv-wind-load-forecast'
      ? record.fallback
        ? `预测完成（${record.requestedModel}→${record.usedModel || record.model}）`
        : `${record.kind || 'forecast'} 预测完成`
      : engine
        ? `${engine} ${objective ?? '已求出'}`
        : `最优目标 ${objective ?? '已求出'}`;
  await mark(
    idea.id,
    'solve',
    'done',
    headline,
    undefined,
    result
  );
  await mergeSchemeStageArtifact(idea.id, 'design', {
    agentName: SCHEME_DESIGNER_AGENT,
    output: engine === 'openTEPES'
      ? `规划目标 ${objective ?? '已求出'}`
      : engine === 'tdmg-acopf'
        ? `交流最优目标 ${objective ?? '已求出'}`
        : engine
          ? `${engine} 求解完成 ${objective ?? ''}`
          : `最优目标 ${objective ?? '已求出'}（termination_status=7）`
  });
  await emit(sessionId, idea.id, 'solve', `求解成功，目标值 ${objective ?? '见 result.json'}`);
}

async function pickBestSolvedIdeaId(sessionId: string, ideaIds: string[]) {
  const rows: Array<{ id: string; maximize: boolean; objective: number }> = [];
  for (const id of ideaIds) {
    const idea = await getSchemeIdea(id);
    const result = readWorkspaceJson(sessionId, id, 'result.json');
    if (!idea || !(isOptimalSolve(result) || isTimedMpsSolve(result))) continue;
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    const raw = record.objective ?? record.objective_value;
    const objective = typeof raw === 'number' ? raw : Number(raw);
    rows.push({
      id,
      maximize: isMaximizeGoal(idea),
      objective: Number.isFinite(objective) ? objective : Number.POSITIVE_INFINITY
    });
  }
  if (!rows.length) return null;
  const maximize = rows.filter((row) => row.maximize).length > rows.length / 2;
  rows.sort((left, right) => (maximize ? right.objective - left.objective : left.objective - right.objective));
  return rows[0]!.id;
}

async function runWithTimeout<T>(timeoutMs: number, work: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function runIdeaResearch(sessionId: string, ideaId: string): Promise<'done' | 'in-progress'> {
  const session = await getSchemeSession(sessionId);
  const idea = await getSchemeIdea(ideaId);
  if (!session || !idea) throw new Error('方案或想法不存在。');
  if (idea.solvability !== 'solvable') throw new Error('该想法不可研究。');
  if (ideaLocks.has(ideaId)) return 'in-progress';
  const existing = await listSchemeStages(sessionId, ideaId);
  if (existing.some((stage) => stage.key === 'report' && stage.status === 'done')) return 'done';
  if (
    existing.some((stage) => stage.key === 'solve' && stage.status === 'done')
    && (isOptimalSolve(readWorkspaceJson(sessionId, ideaId, 'result.json'))
      || isTimedMpsSolve(readWorkspaceJson(sessionId, ideaId, 'result.json')))
  ) {
    return 'done';
  }
  if (existing.some((stage) => stage.key === 'solve' && stage.status === 'running')) {
    return 'in-progress';
  }
  ideaLocks.add(ideaId);
  try {

  const rows = await listReadySchemeSolveAttachmentRows(sessionId);
  await setSchemeSessionStatus(sessionId, 'researching', { detail: `正在研究「${idea.title}」`, error: null });
  const { workingDirectory, attachmentPaths } = prepareSchemeIdeaWorkspace(
    sessionId,
    session.seedIdea,
    idea,
    rows,
    (status) => emit(sessionId, ideaId, 'design', status.detail)
  );

    writeFallbackDesign(sessionId, idea);
    const mpsModel = await prepareEsoptMpsWorkspace(sessionId, idea);
    if (mpsModel) {
      await emit(
        sessionId,
        ideaId,
        'design',
        '看到附件是现成的 MPS/LP，这条实验不需要再头脑风暴或改公式，按原文件交给 ESOPT/HiGHS。',
        'thought'
      );
    }
    if (isMgplanIdea(idea.problemClass)) {
      prepareMgplanWorkspace(sessionId, ideaId, { seedFixture: true });
    }
    if (isAcopfIdea(idea.problemClass)) {
      await prepareTdmgWorkspace(sessionId, idea);
    }
    if (isDispatchIdea(idea.problemClass)) {
      prepareDispatchWorkspace(sessionId, idea);
    }
    mark(ideaId, 'design', 'running', '已写入 DESIGN.md，准备建模求解');

    let usedDesigner = false;
    const existingModel = parseModelFile(listIdeaReportFiles(sessionId, ideaId).model);
    if (existingModel.kind === 'invalid') {
      usedDesigner = true;
      mark(ideaId, 'design', 'running', '小模型正在写 model.json');
      emit(sessionId, ideaId, 'design', '启动 scheme-designer（只写 model.json）');
      try {
        await runWithTimeout(SCHEME_DESIGNER_TIMEOUT_MS, (signal) =>
          runSchemeDesigner({
            idea,
            hooks: {
              workingDirectory,
              conversationId: `scheme-design:${sessionId}:${ideaId}`,
              attachmentPaths,
              onStatus: ({ detail }) => {
                if (/ses_[A-Za-z0-9]+/.test(detail)) {
                  rememberAgentUid(ideaId, 'design', SCHEME_DESIGNER_AGENT, detail);
                }
              },
              onStep: (step) => applyAgentStep(sessionId, ideaId, 'design', SCHEME_DESIGNER_AGENT, step),
              signal
            }
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '设计 Agent 失败';
        emit(sessionId, ideaId, 'design', `设计 Agent 未完成，尝试回退：${message}`, 'warn');
      }
    }

    const parsedModel = await ensureDesignArtifacts(sessionId, idea);
    const files = listIdeaReportFiles(sessionId, ideaId);
    mark(ideaId, 'design', files.design ? 'done' : 'failed', files.design ? '设计思路已落盘' : '未写出 DESIGN.md');
    mark(
      ideaId,
      'model',
      parsedModel.kind === 'invalid' ? 'failed' : 'done',
      parsedModel.kind === 'invalid' ? parsedModel.reason || '未写出有效 model.json' : '模型已落盘'
    );
    if (parsedModel.kind === 'invalid' && !files.result) {
      const message = parsedModel.reason || '未写出有效 model.json，无法求解。';
      mark(ideaId, 'solve', 'failed', message.slice(0, 80), message);
      throw new Error(message);
    }

    mark(
      ideaId,
      'solve',
      'running',
      isMgplanIdea(idea.problemClass)
        ? '正在用 openTEPES 求解'
        : isAcopfIdea(idea.problemClass)
          ? '正在用 TDMG AC-OPF 求解'
          : isDispatchIdea(idea.problemClass)
            ? '正在用调度优化 Skill 求解'
            : isLossIdea(idea.problemClass)
              ? '正在计算理论线损'
              : isModelicaIdea(idea.problemClass)
                ? '正在进行 OpenModelica 仿真'
                : isForecastIdea(idea.problemClass)
                  ? '正在进行源荷预测'
          : '正在用 ESOPT CLI 求解'
    );
    await setSchemeSessionProgress(sessionId, 50, '模型已就绪，正在调用数值求解器');
    const result = await ensureSolveResult(sessionId, idea);
    if (isTimedMpsSolve(result) && !isOptimalSolve(result)) {
      const objective = (result as Record<string, unknown>).objective;
      writeWorkspaceText(sessionId, idea.id, 'result.json', `${JSON.stringify(result, null, 2)}\n`);
      mark(ideaId, 'solve', 'done', `HiGHS 达到时限，当前目标 ${objective}`, undefined, result);
      emit(sessionId, ideaId, 'solve', `未证明最优（time_limit），当前目标 ${objective}。这是附件 MPS 的求解结果，不是配料/电网样例。`);
      return 'done';
    }
    if (!isOptimalSolve(result)) {
      mark(ideaId, 'solve', 'failed', '求解未达到最优', undefined, result);
      emit(
        sessionId,
        ideaId,
        'solve',
        isMgplanIdea(idea.problemClass)
          ? '规划求解未达最优'
          : isAcopfIdea(idea.problemClass)
            ? '交流最优潮流未达最优'
            : isDispatchIdea(idea.problemClass) || isLossIdea(idea.problemClass) || isModelicaIdea(idea.problemClass) || isForecastIdea(idea.problemClass)
              ? `${idea.problemClass} 求解未成功`
            : 'termination_status 不是 7，该想法不进入审查',
        'error'
      );
      throw new Error(
        isMgplanIdea(idea.problemClass)
          ? '规划求解未达到最优。'
          : isAcopfIdea(idea.problemClass)
            ? '交流最优潮流未达到最优。'
            : isDispatchIdea(idea.problemClass) || isLossIdea(idea.problemClass) || isModelicaIdea(idea.problemClass) || isForecastIdea(idea.problemClass)
              ? `${idea.problemClass} 求解未成功。`
            : '求解未达到最优（termination_status ≠ 7）。'
      );
    }
    if (!usedDesigner) {
      await mergeSchemeStageArtifact(ideaId, 'design', {
        agentName: SCHEME_DESIGNER_AGENT,
        agentUid: 'cli'
      });
    }
    await markSolveSuccess(sessionId, idea, result);
    return 'done';
  } catch (error) {
    const message = error instanceof Error ? error.message : '研究失败。';
    const runningKeys: SchemeStageKey[] = ['design', 'model', 'solve'];
    const stages = await listSchemeStages(sessionId, ideaId);
    for (const key of runningKeys) {
      const current = stages.find((stage) => stage.key === key);
      if (current?.status === 'running') {
        mark(ideaId, key, 'failed', message.slice(0, 80), message);
      }
    }
    emit(sessionId, ideaId, 'design', message, 'error');
    throw error;
  } finally {
    ideaLocks.delete(ideaId);
    await refreshSessionAggregate(sessionId);
  }
}

async function runWinnerReviewAndWrite(sessionId: string, ideaId: string) {
  const session = await getSchemeSession(sessionId);
  const idea = await getSchemeIdea(ideaId);
  if (!session || !idea) throw new Error('方案或想法不存在。');
  const solved = readWorkspaceJson(sessionId, ideaId, 'result.json');
  if (!isOptimalSolve(solved)) throw new Error('最优方案尚未求出，不能审查。');

  const rows = await listReadySchemeSolveAttachmentRows(sessionId);
  const { workingDirectory } = prepareSchemeIdeaWorkspace(sessionId, session.seedIdea, idea, rows);
  const existingFiles = listIdeaReportFiles(sessionId, ideaId);

  if (existingFiles.reviewSmall && existingFiles.reviewLarge) {
    mark(ideaId, 'review', 'done', '审查意见已存在');
  } else {
    mark(ideaId, 'review', 'running', '正在审查最优方案');
    emit(sessionId, ideaId, 'review', '只对最优方案启动 scheme-reviewer（小模型 + 大模型）');
    await Promise.all([
      runSchemeReviewer({
        idea,
        modelRole: 'small',
        hooks: {
          workingDirectory,
          conversationId: `scheme-review-small:${sessionId}:${ideaId}`,
          onStatus: ({ detail }) => rememberAgentUid(ideaId, 'review', SCHEME_REVIEWER_AGENT, detail),
          onStep: (step) => applyAgentStep(sessionId, ideaId, 'review', SCHEME_REVIEWER_AGENT, step, 'small')
        }
      }).catch((error) => {
        emit(sessionId, ideaId, 'review', `小模型审查异常：${error instanceof Error ? error.message : error}`, 'warn');
      }),
      runSchemeReviewer({
        idea,
        modelRole: 'large',
        hooks: {
          workingDirectory,
          conversationId: `scheme-review-large:${sessionId}:${ideaId}`,
          onStatus: ({ detail }) => rememberAgentUid(ideaId, 'review', SCHEME_REVIEWER_AGENT, detail),
          onStep: (step) => applyAgentStep(sessionId, ideaId, 'review', SCHEME_REVIEWER_AGENT, step, 'large')
        }
      }).catch((error) => {
        emit(sessionId, ideaId, 'review', `大模型审查异常：${error instanceof Error ? error.message : error}`, 'warn');
      })
    ]);
    writeFallbackReviews(sessionId, idea, solved);
    const reviews = listIdeaReportFiles(sessionId, ideaId);
    if (!reviews.reviewSmall || !reviews.reviewLarge) {
      throw new Error('审查意见未完整落盘。');
    }
    mark(ideaId, 'review', 'done', `已审查最优方案「${idea.title}」`);
    await mergeSchemeStageArtifact(ideaId, 'review', {
      agentName: SCHEME_REVIEWER_AGENT
    });
  }

  if (listIdeaReportFiles(sessionId, ideaId).report) {
    mark(ideaId, 'write', 'done', '报告正文已存在');
    mark(ideaId, 'report', 'done', '技术报告已生成');
    return;
  }

  mark(ideaId, 'write', 'running', '正在撰写最优方案报告');
  emit(sessionId, ideaId, 'write', '只对最优方案启动 scheme-writer');
  try {
    await runSchemeWriter({
      idea,
      hooks: {
        workingDirectory,
        conversationId: `scheme-write:${sessionId}:${ideaId}`,
        onStatus: ({ detail }) => {
          if (/ses_[A-Za-z0-9]+/.test(detail)) {
            rememberAgentUid(ideaId, 'write', SCHEME_WRITER_AGENT, detail);
          }
        },
        onStep: (step) => applyAgentStep(sessionId, ideaId, 'write', SCHEME_WRITER_AGENT, step)
      }
    });
  } catch (error) {
    emit(sessionId, ideaId, 'write', `撰写 Agent 异常，尝试回退：${error instanceof Error ? error.message : error}`, 'warn');
  }
  writeFallbackReport(sessionId, idea, solved);
  if (!listIdeaReportFiles(sessionId, ideaId).report) throw new Error('撰写 Agent 未写出 REPORT.md。');
  mark(ideaId, 'write', 'done', '报告正文已落盘');
  mark(ideaId, 'report', 'done', '技术报告已生成');
  await mergeSchemeStageArtifact(ideaId, 'write', {
    agentName: SCHEME_WRITER_AGENT
  });
  emit(sessionId, ideaId, 'report', '最优方案技术报告已生成');
}

export function isSchemeResearchActive(sessionId: string) {
  return tasks.has(sessionId);
}

export function startSchemeResearch(sessionId: string, ideaIds?: string[]) {
  const active = tasks.get(sessionId);
  if (active) return active;

  const promise = (async () => {
    const targets = (ideaIds?.length ? ideaIds : await listSolvableIdeaIds(sessionId)).filter(Boolean);
    if (!targets.length) throw new Error('没有可研究的想法。');
    await setSchemeSessionStatus(sessionId, 'researching', {
      detail: `正在启动 ${targets.length} 条想法研究`,
      error: null
    });
    await appendSchemeEvent({
      sessionId,
      stage: 'session',
      text: `开始研究 ${targets.length} 条想法（并发 ${SCHEME_RESEARCH_CONCURRENCY}，审查与报告只跑最优方案一次）`
    });
    const errors: string[] = [];
    let progressed = false;
    await mapLimit(targets, SCHEME_RESEARCH_CONCURRENCY, async (ideaId) => {
      try {
        const outcome = await runIdeaResearch(sessionId, ideaId);
        if (outcome !== 'in-progress') progressed = true;
      } catch (error) {
        progressed = true;
        errors.push(error instanceof Error ? error.message : String(error));
      }
    });
    if (!progressed) return;
    let alreadyReported = false;
    for (const item of await listSchemeIdeas(sessionId)) {
      const stages = await listSchemeStages(sessionId, item.id);
      if (stages.some((stage) => stage.key === 'report' && stage.status === 'done')) {
        alreadyReported = true;
        break;
      }
    }
    if (!alreadyReported) {
      const winnerId = await pickBestSolvedIdeaId(sessionId, await listSolvableIdeaIds(sessionId));
      if (winnerId) {
        const winner = await getSchemeIdea(winnerId);
        const solved = readWorkspaceJson(sessionId, winnerId, 'result.json');
        if (isTimedMpsSolve(solved) && !isOptimalSolve(solved)) {
          await setSchemeSessionStatus(sessionId, 'done', {
            detail: `HiGHS 达到时限，当前目标 ${(solved as Record<string, unknown>).objective}`,
            error: null
          });
        } else {
          await setSchemeSessionStatus(sessionId, 'researching', {
            detail: `已选出最优方案「${winner?.title || winnerId}」，开始审查与撰写`,
            error: null
          });
          try {
            await runWinnerReviewAndWrite(sessionId, winnerId);
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
    }
    await refreshSessionAggregate(sessionId);
    if (!alreadyReported && !(await pickBestSolvedIdeaId(sessionId, await listSolvableIdeaIds(sessionId)))) {
      throw new Error(errors[0] || '全部想法研究失败。');
    }
  })().finally(() => {
    tasks.delete(sessionId);
  });

  tasks.set(sessionId, promise);
  return promise;
}

export async function resumeSchemeResearch(sessionId: string) {
  const session = await getSchemeSession(sessionId);
  if (!session || session.status !== 'researching') return;
  if (tasks.has(sessionId)) return;
  if (isJobQueueEnabled()) {
    if (await hasActiveSchemeResearchJob(sessionId)) return;
    enqueueSchemeResearch(sessionId).catch(() => undefined);
    return;
  }
  startSchemeResearch(sessionId).catch(() => undefined);
}

export async function enqueueSchemeResearch(sessionId: string, ideaIds?: string[]) {
  return enqueueOrRun(
    'scheme-research',
    { sessionId, ideaIds: ideaIds || [] },
    () => startSchemeResearch(sessionId, ideaIds)
  );
}
