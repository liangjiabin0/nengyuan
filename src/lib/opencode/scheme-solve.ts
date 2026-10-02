import fs from 'node:fs';
import path from 'node:path';
import { runOpenCodeQuestion } from './runtime';
import {
  SCHEME_BRAINSTORM_AGENT,
  SCHEME_DESIGNER_AGENT,
  SCHEME_DESIGNER_TIMEOUT_MS,
  SCHEME_REVIEWER_TIMEOUT_MS,
  SCHEME_WRITER_TIMEOUT_MS,
  SCHEME_REVIEWER_AGENT,
  SCHEME_SESSION_FILE,
  SCHEME_WRITER_AGENT
} from '@/lib/scheme-solve/constants';
import { inferEsoptCase, normalizeEsoptCase } from '@/lib/scheme-solve/model-json';
import { inferModelicaSpec } from '@/lib/scheme-solve/modelica';
import { inferTdmgCase } from '@/lib/scheme-solve/tdmg-case';
import { resolveForecastKind, resolveForecastModel } from '@/lib/scheme-solve/forecast';
import type { SchemeIdea } from '@/lib/scheme-solve/types';
import type { OpenCodeRunOptions, RuntimeAgentStep } from './types';
import type { OpenCodeAttachment } from './attachments';

function storageRelative(absolutePath: string) {
  const storageRoot = path.resolve(process.cwd(), 'storage');
  const resolved = path.resolve(absolutePath);
  if (resolved === storageRoot) return '.';
  if (resolved.startsWith(`${storageRoot}${path.sep}`)) {
    return resolved.slice(storageRoot.length + 1).replace(/\\/g, '/');
  }
  return resolved.replace(/\\/g, '/');
}

function promptWorkspaceRel(absolutePath: string) {
  const rel = storageRelative(absolutePath);
  if (rel === '.') return '.';
  if (rel.startsWith('storage/')) return rel.slice('storage/'.length);
  return rel;
}

const WORKSPACE_FILE_LIMIT = 16000;

function readPromptFile(dir: string, name: string) {
  try {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (text.length <= WORKSPACE_FILE_LIMIT) return text.trim() || `（${name} 为空）`;
    return `${text.slice(0, WORKSPACE_FILE_LIMIT).trim()}\n\n…（已截断）`;
  } catch {
    return `（未找到 ${name}）`;
  }
}

function workspaceFilesBlock(dir: string, names: string[]) {
  return names
    .map((name) => `======= ${name} =======\n${readPromptFile(dir, name)}`)
    .join('\n\n');
}

const CORPUS_READ_TOOLS = {
  read: true,
  list: true,
  glob: true,
  grep: true,
  bash: false,
  edit: false,
  write: false,
  skill: false,
  task: false,
  webfetch: false,
  websearch: false,
  todowrite: false,
  lsp: false
} as const;

const WRITE_TOOLS = {
  read: true,
  list: true,
  glob: true,
  grep: true,
  bash: true,
  edit: true,
  write: true,
  skill: true,
  task: false,
  webfetch: false,
  websearch: false,
  todowrite: false,
  lsp: false
} as const;

type RunHooks = {
  workingDirectory: string;
  conversationId: string;
  attachmentPaths?: OpenCodeAttachment[];
  onStatus?: OpenCodeRunOptions['onStatus'];
  onStep?: (step: RuntimeAgentStep) => void | Promise<void>;
  signal?: AbortSignal;
};

function isUnavailableLargeModelError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:401|403|404|429)\b|AccessDenied|Unpurchased|Unauthorized|authentication|not authorized|model\s+(?:is\s+)?(?:denied|unavailable|not found)|quota|billing/i.test(message);
}

async function runSchemeModel(
  prompt: string,
  options: OpenCodeRunOptions,
  modelRole: 'small' | 'large'
) {
  if (modelRole === 'small') {
    return runOpenCodeQuestion(prompt, { ...options, modelRole: 'small' });
  }

  try {
    return await runOpenCodeQuestion(prompt, { ...options, modelRole: 'large' });
  } catch (error) {
    if (options.signal?.aborted || !isUnavailableLargeModelError(error)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    options.onStatus?.({
      phase: 'model_fallback',
      detail: `大模型不可用，已回退项目小模型：${detail.slice(0, 240)}`
    });
    return runOpenCodeQuestion(prompt, {
      ...options,
      conversationId: options.conversationId
        ? `${options.conversationId}:small-fallback`
        : undefined,
      sessionTitle: `${options.sessionTitle || 'scheme'}-small-fallback`,
      modelRole: 'small',
      smallThinking: 'xhigh'
    });
  }
}

function designerSkillName(problemClass?: string | null) {
  switch (problemClass) {
    case 'modelica':
      return 'modelica-standard-style';
    case 'dispatch':
      return 'power-dispatch-optimization';
    case 'loss':
      return 'nwxs-theoretical-loss-calculation';
    case 'acopf':
      return 'tdmg-acopf-dispatch';
    case 'mgplan':
      return 'mgplan-calculation';
    case 'forecast':
      return 'pv-wind-load-forecast';
    case 'dcopf':
    case 'lp':
    case 'mip':
      return 'esopt';
    default:
      return '';
  }
}

function designerSkillPrompt(problemClass?: string | null) {
  const skill = designerSkillName(problemClass);
  return skill ? `可 skill 加载 ${skill}，` : '禁止 skill，';
}

function attachmentBlock(paths: OpenCodeAttachment[] | undefined, workspaceRel?: string) {
  if (!paths?.length) return '本轮没有附件。';
  const lines = paths
    .slice(0, 12)
    .map((item, index) => {
      const pointer = item.originalRelativePath || item.relativePath;
      const rel = pointer.replace(/\\/g, '/');
      const target = workspaceRel && !rel.startsWith('scheme-solve/') && !rel.startsWith('storage/')
        ? `${workspaceRel}/${rel}`
        : rel.startsWith('storage/scheme-solve/')
          ? rel.slice('storage/'.length)
          : rel;
      const note = item.kind === 'archive' ? '（未解压，由你决定是否解压）' : '';
      return `${index + 1}. ${item.name} → ${target}${note}`;
    })
    .join('\n');
  return `附件按原样存放，系统未解压、未预解析。\n${lines}`;
}

export async function runSchemeBrainstorm(input: {
  seedIdea: string;
  hooks: RunHooks;
}) {
  const rel = promptWorkspaceRel(input.hooks.workingDirectory);
  const prompt = [
    '你正在「方案求解」中做头脑风暴。只输出一个 JSON 对象，不要 Markdown 解释。',
    '可研究类型：dcopf / lp / mip（ESOPT）；mgplan（openTEPES 规划）；acopf（TDMG 交流 OPF）；dispatch（IEEE/pandapower 调度优化 Skill）；loss（南网理论线损）；modelica（OpenModelica 动态仿真）；forecast（光伏/风电/负荷预测）。',
    '只说直流最优潮流/DCOPF/PGLib/RTS24/IEEE 24 直流 标 dcopf，caseHint 必须是 case24 或 case500，禁止标 dispatch。',
    '只说交流最优潮流/电压极限/MATPOWER 交流/IEEE 9 标 acopf，caseHint=case9；文中有储能 SOC 但是电网优化约束时仍标 acopf，不要标 modelica。',
    '用户明确要求 pandapower、RunSpec、IEEE14/30/57/118 有功无功调度 Skill 或 case33bw 才标 dispatch；6 条想法要按算例分叉（ieee14/ieee30/case33bw），不要 6 条都写同一份 IEEE14。',
    '馈线理论线损/17 张表标 loss。仅当问题是 .mo / DAE / 物理动态仿真时标 modelica。风光荷预测标 forecast。源网荷储投资规划/openTEPES/sSEP 标 mgplan。',
    '三相不平衡、机组组合 MIP、N-1/SCOPF、完整交直流耦合、热系统/合成氨/数据中心扩展必须放进 rejected。',
    'JSON 形状：',
    '{"ideas":[{"title":"","summary":"","problemClass":"dcopf|lp|mip|mgplan|acopf|dispatch|loss|modelica|forecast","decisions":"","limits":"","goal":"","caseHint":"ieee14|case9|sSEP|sample|BatterySOC|pv|custom","whySolvable":""}],"rejected":[{"title":"","reason":""}]}',
    `原始构想：\n${input.seedIdea}`,
    `附件：\n${attachmentBlock(input.hooks.attachmentPaths, rel)}`,
    'INDEX.md / IDEA.md 全文已在下方，不要在 knowledge-corpus 里找这两份工作区文件。',
    '必须先按构想关键词检索本地语料，再产出想法：对 knowledge-corpus/papers、knowledge-corpus/patents、knowledge-corpus/books、knowledge-corpus/projects、knowledge-corpus/national-projects 做分域 grep，命中后只 read 少量相关条目。禁止 glob/list 整个 knowledge-corpus 根，禁止 mentors。ideas 最多 6 条，每条必须写清决策、约束、目标三句话，并尽量能在语料中找到依据。',
    workspaceFilesBlock(input.hooks.workingDirectory, ['INDEX.md', 'IDEA.md'])
  ].join('\n\n');

  return runSchemeModel(prompt, {
    conversationId: input.hooks.conversationId,
    agent: SCHEME_BRAINSTORM_AGENT,
    sessionTitle: 'scheme-brainstorm',
    sessionMapFile: SCHEME_SESSION_FILE,
    tools: { ...CORPUS_READ_TOOLS },
    rawPrompt: true,
    skipCorpusCheck: true,
    onStatus: input.hooks.onStatus,
    onStep: input.hooks.onStep,
    signal: input.hooks.signal
  }, 'large');
}

export async function runSchemeDesigner(input: {
  idea: SchemeIdea;
  hooks: RunHooks;
}) {
  const rel = promptWorkspaceRel(input.hooks.workingDirectory);
  const prompt = [
    '你正在为一条可研究想法写求解模型。工作目录是 storage，路径以 scheme-solve/ 开头。',
    `DESIGN.md 已经写在 ${rel}/DESIGN.md，禁止再写 DESIGN.md，${designerSkillPrompt(input.idea.problemClass)}禁止求解。`,
    input.idea.problemClass === 'mgplan'
      ? `只做一件事：立刻 write ${rel}/model.json 为 {"engine":"openTEPES","case":"sSEP","configDir":"mgplan/config"}。基于 sSEP 模板，禁止写 ESOPT 变量式，禁止求解。`
      : input.idea.problemClass === 'acopf'
        ? `只做一件事：立刻 write ${rel}/model.json 为 {"engine":"tdmg-acopf","case":"${input.idea.caseHint || inferTdmgCase(`${input.idea.title} ${input.idea.summary}`) || 'case9'}","configDir":"tdmg/input","mode":"${/输配微|日前|储能|SOC|多时段/i.test(`${input.idea.title} ${input.idea.summary}`) ? 'scenario' : 'snapshot'}"}。系统会先 task_pipeline 再执行 generated_dispatch.py。禁止写 ESOPT 变量式，禁止求解。`
        : input.idea.problemClass === 'dispatch'
          ? `立刻 write ${rel}/model.json 为 {"engine":"power-dispatch","specPath":"dispatch/run-spec.yaml","case":"${input.idea.caseHint || 'ieee14'}"}。可按 skill 补写 ${rel}/dispatch/run-spec.yaml；已有自定义 yaml 时系统不会覆盖。求解前会 validate。禁止求解。`
          : input.idea.problemClass === 'loss'
            ? `只做一件事：立刻 write ${rel}/model.json 为 {"engine":"nwxs-loss","input":"loss/input.json","format":"full","method":"04"}。可写 workers。没有馈线附件时会用样例并标明 sample。禁止求解。`
            : input.idea.problemClass === 'modelica'
              ? `立刻 write ${rel}/model.json 为 ${JSON.stringify({
                engine: 'openmodelica',
                modelFile: 'modelica/model.mo',
                model_name: inferModelicaSpec(`${input.idea.caseHint || ''} ${input.idea.title} ${input.idea.summary}`).name,
                outputs: inferModelicaSpec(`${input.idea.caseHint || ''} ${input.idea.title} ${input.idea.summary}`).outputs
              })}，并 write ${rel}/modelica/model.mo，模型名必须与 model_name 一致。禁止写 result.json，禁止伪造仿真数值。`
              : input.idea.problemClass === 'forecast'
                ? `只做一件事：立刻 write ${rel}/model.json 为 ${JSON.stringify({
                  engine: 'pv-wind-load-forecast',
                  kind: resolveForecastKind(`${input.idea.caseHint || ''} ${input.idea.title} ${input.idea.summary}`),
                  model: resolveForecastModel(`${input.idea.caseHint || ''} ${input.idea.title} ${input.idea.summary}`),
                  action: 'predict',
                  horizon: 24,
                  variant: 'v3'
                })}。kind 可为 pv/wind/load/energy，负荷可写 variant v1-v5。禁止求解。`
        : `只做一件事：立刻 write ${rel}/model.json，必须是可被 ESOPT 直接求解的 JSON。${
          input.idea.problemClass === 'dcopf'
            ? ` 标准算例写成 {"case":"${normalizeEsoptCase(input.idea.caseHint) || inferEsoptCase(`${input.idea.caseHint || ''} ${input.idea.title} ${input.idea.summary}`) || 'case24'}"}。需要 PSLP 时在构想里写 PSLP。`
            : input.idea.problemClass === 'lp' || input.idea.problemClass === 'mip'
              ? ' 必须按用户构想里的变量名、约束和目标来写，禁止改成配料或背包例题。constraints 每一项必须是 {"name":"...","expr":"..."} 对象，禁止写成字符串。若附件是 .mps/.lp，不要手写 variables，写成 {"engine":"esopt","mode":"mps","modelFile":"esopt/文件名.mps"}。'
              : ''
        }`,
    ['mgplan', 'acopf', 'dispatch', 'loss', 'modelica', 'forecast'].includes(String(input.idea.problemClass)) ? '' : '- 仅当算例提示是 case24/case500 这类标准电网算例时，写成 {"case":"case24"}',
    ['mgplan', 'acopf', 'dispatch', 'loss', 'modelica', 'forecast'].includes(String(input.idea.problemClass)) ? '' : '- 若附件是 .mps/.lp，写成 {"engine":"esopt","mode":"mps","modelFile":"esopt/xxx.mps"}，禁止把大型 MPS 抄成 variables JSON',
    ['mgplan', 'acopf', 'dispatch', 'loss', 'modelica', 'forecast'].includes(String(input.idea.problemClass)) ? '' : '- 自定义 LP/MIP 必须含 variables 数组、constraints、objective；variables 里每项要有 name',
    ['mgplan', 'acopf', 'dispatch', 'loss', 'modelica', 'forecast'].includes(String(input.idea.problemClass)) ? '' : '- 禁止只写说明、Markdown 代码块，或缺少 variables 的空对象',
    ['mgplan', 'acopf', 'dispatch', 'loss', 'modelica', 'forecast'].includes(String(input.idea.problemClass)) ? '' : '- 可用 expr，例如 "min 2*x + 3*y"、"3*x + 2*y <= 10"',
    `问题类型：${input.idea.problemClass}`,
    `构想原文：${input.idea.summary}`,
    `决策：${input.idea.decisions}`,
    `约束：${input.idea.limits}`,
    `目标：${input.idea.goal}`,
    input.idea.caseHint ? `算例提示：${input.idea.caseHint}` : '',
    `附件：\n${attachmentBlock(input.hooks.attachmentPaths, rel)}`,
    '工作区文件已在下方，禁止去 knowledge-corpus 查找。写完即停。公开回复只写「已写入 model.json」。',
    workspaceFilesBlock(input.hooks.workingDirectory, ['INDEX.md', 'IDEA.md', 'DESIGN.md'])
  ]
    .filter(Boolean)
    .join('\n\n');

  return runSchemeModel(prompt, {
    conversationId: input.hooks.conversationId,
    agent: SCHEME_DESIGNER_AGENT,
    sessionTitle: 'scheme-designer',
    sessionMapFile: SCHEME_SESSION_FILE,
    tools: { ...WRITE_TOOLS, skill: Boolean(designerSkillName(input.idea.problemClass)) },
    rawPrompt: true,
    skipCorpusCheck: true,
    timeoutMs: SCHEME_DESIGNER_TIMEOUT_MS,
    onStatus: input.hooks.onStatus,
    onStep: input.hooks.onStep,
    signal: input.hooks.signal
  }, 'small');
}

export async function runSchemeReviewer(input: {
  idea: SchemeIdea;
  modelRole: 'small' | 'large';
  hooks: RunHooks;
}) {
  const rel = promptWorkspaceRel(input.hooks.workingDirectory);
  const outFile = input.modelRole === 'small' ? 'review-small.md' : 'review-large.md';
  const focus =
    input.modelRole === 'small'
      ? input.idea.problemClass === 'mgplan'
        ? '只做形式校核：result.json 是否含 engine=openTEPES、status=optimal、objective、costSummary/investment/evaluations；不要要求 termination_status=7。'
        : input.idea.problemClass === 'acopf'
          ? '只做形式校核：result.json 是否含 engine=tdmg-acopf、status=optimal、objective；可对照 RESULTS.md 的电压、支路负载、网损；不要要求 termination_status=7。'
          : ['dispatch', 'loss', 'modelica', 'forecast'].includes(String(input.idea.problemClass))
            ? '只做形式校核：result.json 是否含 engine、ok/success。dispatch 若 fixture/planned 必须判未真实求解。loss 看线损率，source=sample 必须写明样例馈线。modelica 看 series。forecast 必须对照 requestedModel 与 usedModel/fallback。不要要求 termination_status=7。'
          : '只做形式校核：变量/约束是否线性、result.json 的 termination_status 是否为 7、目标值是否写出、单位是否自洽。'
      : input.idea.problemClass === 'acopf'
        ? '对照 IDEA.md 与附件，审查工程含义：交流模型是否表达原问题、电压/支路/成本是否合理、有何局限。只引用 result.json / RESULTS.md 中的数字，禁止编造。'
        : input.idea.problemClass === 'dispatch'
          ? '对照 IDEA.md 与 result.json：审查调度目标、越限、储能 SOC 与 model_fidelity；dry-run/fixture 必须写明未做真实潮流，不能写成已求出最优。禁止编造。'
          : input.idea.problemClass === 'loss'
            ? '对照 IDEA.md 与 result.json：审查线损率、有功/铁损/铜损是否自洽，并核对 17 张表是否齐全；source=sample 必须写明不是用户馈线。禁止编造。'
            : input.idea.problemClass === 'modelica'
              ? '对照 IDEA.md、model.mo 与 result.json：审查模型方程、仿真曲线与参数；禁止补造未出现的 SOC/电压数值。'
              : input.idea.problemClass === 'forecast'
                ? '对照 IDEA.md 与 result.json：审查预测种类、requestedModel/usedModel、MAE/RMSE 与 profileCsv；若 fallback=true 必须写明 Ridge/SVR 回退，不得写成已跑通 LSTM/CNN。禁止编造。'
                : '对照 IDEA.md 与附件，审查工程含义：模型是否表达了原问题、结果是否合理、有何局限。mgplan 应核对应投资、成本、储能与购售电摘要，禁止编造未出现的数字。';
  const prompt = [
    `你是方案求解审查员（${input.modelRole === 'small' ? '小模型形式校核' : '大模型工程审查'}）。`,
    `工作目录是 storage。相关文件全文已在下方，禁止去 knowledge-corpus 查找。如需核对只能 read ${rel}/ 下的同名文件。`,
    focus,
    `把审查意见写入 ${rel}/${outFile}。公开回复只写三条结论。`,
    '禁止编造未出现在 result.json 中的数字。',
    workspaceFilesBlock(input.hooks.workingDirectory, [
      'INDEX.md',
      'IDEA.md',
      'DESIGN.md',
      'model.json',
      'result.json',
      ...(input.idea.problemClass === 'acopf' || input.idea.problemClass === 'mgplan' ? ['RESULTS.md'] : [])
    ])
  ].join('\n\n');

  return runSchemeModel(prompt, {
    conversationId: input.hooks.conversationId,
    agent: SCHEME_REVIEWER_AGENT,
    sessionTitle: `scheme-reviewer-${input.modelRole}`,
    sessionMapFile: SCHEME_SESSION_FILE,
    tools: { ...WRITE_TOOLS, skill: false },
    rawPrompt: true,
    skipCorpusCheck: true,
    timeoutMs: SCHEME_REVIEWER_TIMEOUT_MS,
    onStatus: input.hooks.onStatus,
    onStep: input.hooks.onStep,
    signal: input.hooks.signal
  }, input.modelRole);
}

export async function runSchemeWriter(input: {
  idea: SchemeIdea;
  hooks: RunHooks;
}) {
  const rel = promptWorkspaceRel(input.hooks.workingDirectory);
  const prompt = [
    '你正在撰写技术方案报告。工作目录是 storage，路径以 scheme-solve/ 开头。',
    `相关文件全文已在下方，禁止去 knowledge-corpus 查找。如需核对只能 read ${rel}/ 下的同名文件。`,
    `把完整报告写入 ${rel}/REPORT.md。数字必须来自 result.json，审查意见作为「校核记录」附录。`,
    input.idea.problemClass === 'mgplan'
      ? 'mgplan 报告需写清投资、成本构成、储能容量、购售电、弃电与技术经济评价；可引用 RESULTS.md，禁止编造。'
      : input.idea.problemClass === 'acopf'
        ? 'acopf 报告需写清发电成本、电压越限、支路负载、网损与区域交换；可引用 RESULTS.md，禁止编造。'
        : input.idea.problemClass === 'dispatch'
          ? 'dispatch 报告需写清算例、目标值、越限、储能轨迹与 backend/model_fidelity；若 fixture/dry-run 必须写明未做真实潮流。'
          : input.idea.problemClass === 'loss'
            ? 'loss 报告需写清馈线线损率、有功/铁损/铜损，并列出 17 张结果表与图/HTML 产物；若 source=sample 必须写明用的是样例馈线。'
            : input.idea.problemClass === 'modelica'
              ? 'modelica 报告需写清模型名、方程含义、仿真区间与 result.json 中的曲线；禁止补造数值。'
              : input.idea.problemClass === 'forecast'
                ? 'forecast 报告需写清预测对象、requestedModel/usedModel、误差指标与可回灌调度的 profileCsv；fallback 时不得写成深度学习已跑通。'
                : '',
    '不要调用 skill。禁止编造未求解数字。公开回复只写报告标题与目标值。',
    workspaceFilesBlock(input.hooks.workingDirectory, [
      'INDEX.md',
      'IDEA.md',
      'DESIGN.md',
      'model.json',
      'result.json',
      'review-small.md',
      'review-large.md',
      ...(input.idea.problemClass === 'acopf' || input.idea.problemClass === 'mgplan' ? ['RESULTS.md'] : [])
    ])
  ].join('\n\n');

  return runSchemeModel(prompt, {
    conversationId: input.hooks.conversationId,
    agent: SCHEME_WRITER_AGENT,
    sessionTitle: 'scheme-writer',
    sessionMapFile: SCHEME_SESSION_FILE,
    tools: { ...WRITE_TOOLS, skill: false },
    rawPrompt: true,
    skipCorpusCheck: true,
    timeoutMs: SCHEME_WRITER_TIMEOUT_MS,
    onStatus: input.hooks.onStatus,
    onStep: input.hooks.onStep,
    signal: input.hooks.signal
  }, 'large');
}
