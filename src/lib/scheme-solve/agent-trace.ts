import { summarizeWebTool } from '@/lib/opencode/tool-summary';
import type { RuntimeAgentStep } from '@/lib/opencode/types';
import { readSolveObjective } from './best-idea';
import type {
  SchemeAgentStep,
  SchemeAgentTrace,
  SchemeEvent,
  SchemeIdeaView,
  SchemeSessionSnapshot,
  SchemeStage,
  SchemeStageKey
} from './types';

export type InspectorTraceKind = 'thought' | 'plan' | 'tool' | 'observe' | 'info' | 'warn' | 'error';

export type InspectorTraceItem = {
  id: string;
  kind: InspectorTraceKind;
  label: string;
  body: string;
  time?: string;
  durationMs?: number;
  lane?: string;
};

export type SchemeLiveTraceItem = {
  key: string;
  kind: InspectorTraceKind | 'output';
  text: string;
  tool?: string;
};

export type SchemeArtifactFiles = {
  design: string;
  model: string;
  result: string;
  results?: string;
  reviewSmall: string;
  reviewLarge: string;
  report: string;
};

const PROBLEM_CLASS_LABEL: Record<string, string> = {
  dcopf: '直流最优潮流',
  lp: '线性规划',
  mip: '混合整数规划',
  mgplan: '多能系统规划',
  acopf: '交流最优潮流',
  dispatch: '优化调度',
  loss: '理论线损',
  modelica: 'Modelica 仿真',
  forecast: '源荷预测'
};

export function problemClassLabel(value?: string) {
  return (value && PROBLEM_CLASS_LABEL[value]) || value || '未标注';
}

function fileLabel(value: string) {
  const text = value.replace(/\\/g, '/').trim();
  if (!text) return '';
  const parts = text.split('/');
  return parts.slice(-2).join('/');
}

function truncate(value: string, max: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function summarizeToolStep(step: Pick<RuntimeAgentStep, 'tool' | 'input' | 'content'>) {
  const input = step.input || {};
  const tool = step.tool || '';
  const fallback = truncate(String(step.content || '').replace(new RegExp(`^(调用\\s+)?${tool}：?`, 'i'), ''), 80);
  if (tool === 'read') {
    return { verb: '读取工作区', detail: fileLabel(String(input.path || input.filePath || '')) || fallback || '文件' };
  }
  if (tool === 'grep') {
    return {
      verb: '检索语料',
      detail: `${truncate(String(input.pattern || input.query || fallback), 48)} @ ${fileLabel(String(input.path || input.include || input.glob || '')) || '工作区'}`
    };
  }
  if (tool === 'glob') {
    return { verb: '匹配路径', detail: `${truncate(String(input.pattern || input.glob || '*'), 48)} @ ${fileLabel(String(input.path || '')) || '工作区'}` };
  }
  if (tool === 'list') {
    return { verb: '列出目录', detail: fileLabel(String(input.path || '.')) || fallback || '.' };
  }
  if (tool === 'write') {
    return { verb: '写入文件', detail: fileLabel(String(input.path || input.filePath || '')) || fallback || '文件' };
  }
  if (tool === 'edit') {
    return { verb: '修订文件', detail: fileLabel(String(input.path || input.filePath || '')) || fallback || '文件' };
  }
  if (tool === 'skill') {
    return { verb: '调用技能', detail: String(input.name || input.skill || fallback || tool) };
  }
  const web = summarizeWebTool(tool, input, fallback);
  if (web) return { verb: web.verb, detail: web.detail || fallback || '已执行' };
  return { verb: tool || '工具', detail: fallback || '已执行' };
}

export function formatRuntimeStep(step: RuntimeAgentStep, lane?: string): { eventText: string; stored: SchemeAgentStep } | null {
  const content = step.content.trim();
  if (step.type === 'tool_call') {
    const summary = summarizeToolStep(step);
    return {
      eventText: `[tool:${step.tool || 'call'}] ${summary.verb} · ${summary.detail}`,
      stored: {
        type: 'tool_call',
        step: step.step,
        tool: step.tool,
        content: `${summary.verb} · ${summary.detail}`,
        durationMs: step.durationMs,
        lane
      }
    };
  }
  if (step.type === 'observation') {
    if (!content) return null;
    const snippet = content.slice(0, 1200);
    return {
      eventText: `[observe] ${snippet}`,
      stored: { type: 'observation', step: step.step, tool: step.tool, content: snippet, durationMs: step.durationMs, lane }
    };
  }
  if (step.type === 'thought' || step.type === 'plan') {
    if (content.length < 6) return null;
    return {
      eventText: `[${step.type}] ${content.slice(0, 4000)}`,
      stored: { type: step.type, step: step.step, content: content.slice(0, 4000), durationMs: step.durationMs, lane }
    };
  }
  if (step.type === 'public_text' || step.type === 'synthesis') {
    if (!content) return null;
    return {
      eventText: `[output] ${content.slice(0, 4000)}`,
      stored: { type: step.type, step: step.step, content: content.slice(0, 4000), durationMs: step.durationMs, lane }
    };
  }
  return null;
}

export function mergeAgentSteps(current: SchemeAgentStep[] | undefined, incoming: SchemeAgentStep[] | undefined) {
  const steps = [...(current || [])];
  for (const item of incoming || []) {
    const index = steps.findIndex((row) => row.step === item.step && row.type === item.type && (row.lane || '') === (item.lane || ''));
    if (index >= 0) steps[index] = { ...steps[index], ...item };
    else steps.push(item);
  }
  return steps.slice(-120);
}

function stageOf(stages: SchemeStage[], key: SchemeStageKey) {
  return stages.find((stage) => stage.key === key);
}

function parsePrefixedEvent(event: SchemeEvent): InspectorTraceItem | null {
  const text = event.text.trim();
  if (!text) return null;
  const time = event.createdAt;
  const tagged = text.match(/^\[(thought|plan|output|observe|tool:([^\]]+))\]\s*([\s\S]*)$/);
  if (tagged) {
    const tag = tagged[1] || '';
    const body = (tagged[3] || '').trim();
    if (tag === 'thought') return { id: `event:${event.id}`, kind: 'thought', label: '内部推理', body, time };
    if (tag === 'plan') return { id: `event:${event.id}`, kind: 'plan', label: '步骤规划', body, time };
    if (tag === 'observe') return { id: `event:${event.id}`, kind: 'observe', label: '工具回读', body, time };
    if (tag.startsWith('tool:')) {
      return { id: `event:${event.id}`, kind: 'tool', label: tagged[2] ? `工具 · ${tagged[2]}` : '工具调用', body, time };
    }
    return { id: `event:${event.id}`, kind: 'info', label: '阶段输出', body, time };
  }
  if (event.level === 'thought') return { id: `event:${event.id}`, kind: 'thought', label: '内部推理', body: text, time };
  if (event.level === 'output') return { id: `event:${event.id}`, kind: 'info', label: '阶段输出', body: text, time };
  if (event.level === 'error') return { id: `event:${event.id}`, kind: 'error', label: '异常', body: text, time };
  if (event.level === 'warn') return { id: `event:${event.id}`, kind: 'warn', label: '回退与校正', body: text, time };
  if (/启动|写入|求解|审查|撰写|会话|ses_/.test(text)) {
    return { id: `event:${event.id}`, kind: 'info', label: '编排进度', body: text, time };
  }
  return { id: `event:${event.id}`, kind: 'info', label: '过程记录', body: text, time };
}

function fromStoredStep(step: SchemeAgentStep, index: number): InspectorTraceItem {
  const id = `step:${step.lane || ''}:${step.type}:${step.step ?? index}`;
  const lane = step.lane === 'small' ? '小模型 · ' : step.lane === 'large' ? '大模型 · ' : '';
  if (step.type === 'tool_call') return { id, kind: 'tool', label: `${lane}${step.content.split(' · ')[0] || '工具调用'}`, body: step.content, durationMs: step.durationMs, lane: step.lane };
  if (step.type === 'observation') return { id, kind: 'observe', label: `${lane}观察结果`, body: step.content, durationMs: step.durationMs, lane: step.lane };
  if (step.type === 'plan') return { id, kind: 'plan', label: `${lane}步骤规划`, body: step.content, durationMs: step.durationMs, lane: step.lane };
  if (step.type === 'thought') return { id, kind: 'thought', label: `${lane}内部推理`, body: step.content, durationMs: step.durationMs, lane: step.lane };
  return { id, kind: 'info', label: `${lane}对外陈述`, body: step.content, durationMs: step.durationMs, lane: step.lane };
}

function similar(left: string, right: string) {
  const a = left.replace(/\s+/g, '').slice(0, 80);
  const b = right.replace(/\s+/g, '').slice(0, 80);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function excerpt(text: string, max = 420) {
  const clean = text.replace(/\r/g, '').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trim()}…`;
}

function narrativeForRoot(session: SchemeSessionSnapshot, attachments: number): InspectorTraceItem[] {
  const solvable = session.ideas.filter((item) => item.solvability === 'solvable');
  const rejected = session.ideas.filter((item) => item.solvability === 'rejected');
  return [
    {
      id: 'narr:parse',
      kind: 'plan',
      label: '拆解原始构想',
      body: `先把用户构想压成可检验的决策问题：明确目标函数、决策变量与硬约束，并判断它是否落在本机可解范围（直流最优潮流 / 线性规划 / 混合整数规划 / 多能规划 / 交流最优潮流）。${attachments ? `同时把 ${attachments} 个附件当作局部证据，而不是另起一套问题。` : '本轮没有附件，主要依据构想文本与本地语料。'}`
    },
    {
      id: 'narr:filter',
      kind: 'thought',
      label: '筛选可解边界',
      body: '输配微协同交流最优潮流可进入 acopf；三相不平衡、机组组合、N-1/SCOPF、完整交直流耦合以及自定义二次/sin/cos 仍进入不可研究。直流标准算例优先落到 case24 一类 PGLib 别名。'
    },
    {
      id: 'narr:tree',
      kind: 'info',
      label: '形成想法树',
      body: solvable.length || rejected.length
        ? [
            solvable.length ? `可研究 ${solvable.length} 条：${solvable.map((item) => `「${item.title}」`).join('、')}。` : '',
            rejected.length ? `不可研究 ${rejected.length} 条：${rejected.map((item) => `「${item.title}」${item.rejectReason ? `（${item.rejectReason}）` : ''}`).join('；')}。` : ''
          ].filter(Boolean).join('\n')
        : '想法树尚未写出。头脑风暴完成后，会按可研究 / 不可研究两列展开。'
    }
  ];
}

function narrativeForIdea(idea: SchemeIdeaView): InspectorTraceItem[] {
  const rejected = idea.solvability === 'rejected';
  return [
    {
      id: 'narr:frame',
      kind: 'plan',
      label: '定位这条研究方向',
      body: `从头脑风暴结果中单独抽出「${idea.title}」。问题类型按 ${problemClassLabel(idea.problemClass)} 处理${idea.caseHint ? `，算例提示为 ${idea.caseHint}` : ''}。下面只评价它能不能交给本机求解器一次解完，而不是继续发散。`
    },
    {
      id: 'narr:structure',
      kind: 'thought',
      label: '核对三要素',
      body: [
        idea.decisions ? `决策：${idea.decisions}` : '决策尚未写清。',
        idea.limits ? `约束：${idea.limits}` : '约束尚未写清。',
        idea.goal ? `目标：${idea.goal}` : '目标尚未写清。'
      ].join('\n')
    },
    {
      id: 'narr:verdict',
      kind: rejected ? 'warn' : 'info',
      label: rejected ? '判定为不可研究' : '判定为可研究',
      body: rejected
        ? idea.rejectReason || idea.summary
        : idea.whySolvable || idea.summary
    }
  ];
}

function narrativeForDesign(idea: SchemeIdeaView | undefined, artifact: SchemeArtifactFiles | null): InspectorTraceItem[] {
  const solve = idea ? stageOf(idea.stages, 'solve') : undefined;
  const objective = readSolveObjective(solve?.artifactJson);
  return [
    {
      id: 'narr:route',
      kind: 'plan',
      label: '选择建模路线',
      body: idea?.problemClass === 'modelica'
        ? `按 Modelica 建模，写 modelica/model.mo 与 {"engine":"openmodelica","model_name":"${idea.caseHint || '模型名'}"}，交给 OpenModelica 做 checkModel 与仿真。`
        : idea?.problemClass === 'forecast'
          ? '按源荷预测配置 kind/model，交给光伏/风电/负荷预测侧车出曲线，禁止口算冒充。'
          : idea?.problemClass === 'loss'
            ? '按南网理论线损写 {"engine":"nwxs-loss"}。没有馈线附件时必须标明使用样例馈线。'
            : idea?.problemClass === 'dispatch'
              ? `按电力系统优化调度写 RunSpec，算例提示 ${idea.caseHint || 'ieee14'}，交给 pandapower/Pyomo。`
              : idea?.problemClass === 'mgplan'
                ? '按 openTEPES 多能规划写 sSEP 配置。没有 Gurobi 时必须失败说明，禁止样例冒充最优。'
                : idea?.problemClass === 'acopf'
                  ? `按交流最优潮流写 {"engine":"tdmg-acopf","case":"${idea.caseHint || 'case9'}"}，交给 TDMG / PYPOWER。`
        : idea?.caseHint && idea.caseHint !== 'custom'
          ? `算例提示是 ${idea.caseHint}。若问题本质是标准电网运行，就写成 {"case":"${idea.caseHint}"} 交给 DCOPF 求解器；只有自定义配料/背包/投资才展开 variables / constraints / objective。`
          : `没有标准算例提示。上传了 .mps/.lp 时直接交给 HiGHS 读取；否则必须把「${idea?.title || '该想法'}」落成带 variables 数组和 objective 的线性模型，禁止只写说明性 JSON。`
    },
    {
      id: 'narr:spec',
      kind: 'thought',
      label: '对照想法字段建模',
      body: [
        `类型：${problemClassLabel(idea?.problemClass)}`,
        idea?.decisions ? `决策：${idea.decisions}` : '',
        idea?.limits ? `约束：${idea.limits}` : '',
        idea?.goal ? `目标：${idea.goal}` : ''
      ].filter(Boolean).join('\n')
    },
    {
      id: 'narr:files',
      kind: 'tool',
      label: '落盘设计与模型',
      body: [
        artifact?.design ? `DESIGN.md 已写入（${artifact.design.trim().split(/\n/).length} 行）。` : 'DESIGN.md 仍空，编排器会按想法字段补一份。',
        artifact?.model ? `model.json 已写入：${excerpt(artifact.model, 220)}` : 'model.json 尚未形成有效对象。'
      ].join('\n')
    },
    {
      id: 'narr:solve',
      kind: objective != null ? 'info' : 'thought',
      label: '调用求解器并回读',
      body: objective != null
        ? `求解器已返回结果。目标值 ${objective}${solve?.headline ? `；${solve.headline}` : ''}。未达最优的想法不能进入共享审查。`
        : idea?.problemClass === 'acopf'
          ? '等待 TDMG / PYPOWER 回传 result.json。无附件时用内置 IEEE 算例，上传 .m/.mat 时用该算例。'
          : idea?.problemClass === 'modelica'
            ? '等待 OpenModelica 网关回传时序曲线。checkModel 失败必须原样展示编译信息。'
            : idea?.problemClass === 'forecast'
              ? '等待源荷预测侧车回传曲线与误差指标。模型回退必须写明。'
              : idea?.problemClass === 'loss'
                ? '等待南网理论线损回传线损率与结果表。'
                : idea?.problemClass === 'dispatch'
                  ? '等待电力系统优化调度 Skill 回传 RunSpec 结果。'
                  : idea?.problemClass === 'mgplan'
                    ? '等待 openTEPES 回传规划结果。未达 optimal 不能写成已求出。'
          : '等待 ESOPT CLI 回传 result.json。线性模型走 model 命令，标准算例走 solve 命令，二者不会混用。'
    }
  ];
}

function narrativeForReview(idea: SchemeIdeaView | undefined, artifact: SchemeArtifactFiles | null): InspectorTraceItem[] {
  return [
    {
      id: 'narr:scope',
      kind: 'plan',
      label: '限定审查范围',
      body: `只审查当前最优方案「${idea?.title || '未选出'}」。小模型做形式校核（线性、termination_status、目标值是否落盘），大模型做工程对照（模型是否表达原问题、结果是否合理、局限在哪）。两份意见分开落盘，互不覆盖。`
    },
    {
      id: 'narr:small',
      kind: 'thought',
      label: '小模型形式校核',
      body: artifact?.reviewSmall ? excerpt(artifact.reviewSmall, 360) : '小模型审查尚未落盘。若 Agent 超时，编排器会按 result.json 补写形式校核草稿。'
    },
    {
      id: 'narr:large',
      kind: 'thought',
      label: '大模型工程审查',
      body: artifact?.reviewLarge ? excerpt(artifact.reviewLarge, 360) : '大模型审查尚未落盘。工程意见必须对照 IDEA.md 与求解数字，不能编造 result.json 里没有的量。'
    }
  ];
}

function narrativeForWrite(idea: SchemeIdeaView | undefined, artifact: SchemeArtifactFiles | null): InspectorTraceItem[] {
  const headings = (artifact?.report || '').split(/\n/).filter((line) => /^#{1,3}\s+/.test(line)).slice(0, 8);
  return [
    {
      id: 'narr:outline',
      kind: 'plan',
      label: '组织报告结构',
      body: headings.length
        ? `已按审查意见和求解结果组织章节：\n${headings.map((line) => `- ${line.replace(/^#+\s+/, '')}`).join('\n')}`
        : '报告将按问题定义、模型、求解结果、校核记录展开。数字只允许来自 result.json，审查意见只作为附录，不改写最优值。'
    },
    {
      id: 'narr:numbers',
      kind: 'thought',
      label: '核对可引用数字',
      body: artifact?.result
        ? `result.json 摘要：${excerpt(artifact.result, 280)}`
        : '还没有 result.json，不能撰写带数量结论的报告。'
    },
    {
      id: 'narr:draft',
      kind: artifact?.report ? 'info' : 'thought',
      label: artifact?.report ? '报告正文已落盘' : '等待撰写',
      body: artifact?.report ? excerpt(artifact.report, 360) : 'scheme-writer 会把完整 Markdown 写入 REPORT.md；失败时编排器按已有产物补草稿。'
    }
  ];
}

export function composeInspectorTimeline(input: {
  kind: 'root' | 'idea' | 'stage';
  stageKey?: SchemeStageKey;
  session: SchemeSessionSnapshot;
  idea?: SchemeIdeaView;
  events: SchemeEvent[];
  liveTrace?: SchemeLiveTraceItem[];
  artifact?: SchemeArtifactFiles | null;
  trace?: SchemeAgentTrace;
}): InspectorTraceItem[] {
  const collected: InspectorTraceItem[] = [];
  for (const step of input.trace?.steps || []) {
    collected.push(fromStoredStep(step, collected.length));
  }
  for (const event of input.events) {
    const item = parsePrefixedEvent(event);
    if (item) collected.push(item);
  }
  for (const live of input.liveTrace || []) {
    if (live.kind === 'output') {
      collected.push({ id: live.key, kind: 'info', label: '实时输出', body: live.text });
      continue;
    }
    collected.push({
      id: live.key,
      kind: live.kind,
      label: live.kind === 'tool' ? `工具 · ${live.tool || 'call'}` : live.kind === 'plan' ? '步骤规划' : live.kind === 'observe' ? '工具回读' : '内部推理',
      body: live.text
    });
  }

  const unique: InspectorTraceItem[] = [];
  for (const item of collected) {
    if (unique.some((row) => similar(row.body, item.body) && row.kind === item.kind)) continue;
    unique.push(item);
  }

  const narrative = input.kind === 'root'
    ? narrativeForRoot(input.session, input.session.attachments?.length || 0)
    : input.kind === 'idea' && input.idea
      ? narrativeForIdea(input.idea)
      : input.stageKey === 'design'
        ? narrativeForDesign(input.idea, input.artifact || null)
        : input.stageKey === 'review'
          ? narrativeForReview(input.idea, input.artifact || null)
          : input.stageKey === 'write'
            ? narrativeForWrite(input.idea, input.artifact || null)
            : [];

  const realCount = unique.filter((item) => item.kind === 'thought' || item.kind === 'plan' || item.kind === 'tool' || item.kind === 'observe').length;
  if (realCount >= 6) return unique;
  const merged = [...unique];
  for (const item of narrative) {
    if (merged.some((row) => similar(row.body, item.body))) continue;
    merged.push(item);
  }
  return merged;
}

export function composeUserBrief(input: {
  kind: 'root' | 'idea' | 'stage';
  stageKey?: SchemeStageKey;
  session: SchemeSessionSnapshot;
  idea?: SchemeIdeaView;
}) {
  if (input.kind === 'root') {
    return [
      '# 任务',
      '对下面的原始构想做头脑风暴：只产出本机求解器能解的方向，写成想法树。',
      '',
      '## 原始构想',
      input.session.seedIdea,
      '',
      '## 约束',
      '- 问题类型：dcopf / lp / mip / mgplan / acopf',
      '- 交流最优潮流标 acopf；三相不平衡、机组组合、N-1、完整交直流必须进入 rejected',
      '- 每条可研究想法都要写清决策、约束、目标，并尽量给出 caseHint 或语料依据'
    ].join('\n');
  }
  if (input.kind === 'idea' && input.idea) {
    return [
      '# 任务',
      `评估研究方向「${input.idea.title}」是否可以进入后续设计求解流水线。`,
      '',
      '## 原始构想',
      input.session.seedIdea,
      '',
      '## 待评估方向',
      input.idea.summary
    ].join('\n');
  }
  if (input.stageKey === 'design') {
    return [
      '# 任务',
      `为「${input.idea?.title || '当前想法'}」建立可被本机求解器一次求解的模型，并拿到最优解。`,
      '',
      '## 问题定义',
      `- 类型：${problemClassLabel(input.idea?.problemClass)}`,
      input.idea?.decisions ? `- 决策：${input.idea.decisions}` : '',
      input.idea?.limits ? `- 约束：${input.idea.limits}` : '',
      input.idea?.goal ? `- 目标：${input.idea.goal}` : '',
      input.idea?.caseHint ? `- 算例：${input.idea.caseHint}` : '',
      '',
      '## 交付',
      '1. DESIGN.md：把决策/约束/目标写成可核对的设计说明',
      input.idea?.problemClass === 'acopf'
        ? `2. model.json：{"engine":"tdmg-acopf","case":"${input.idea.caseHint || 'case9'}","configDir":"tdmg/input"}`
        : input.idea?.problemClass === 'modelica'
          ? `2. model.json：{"engine":"openmodelica","modelFile":"modelica/model.mo","model_name":"${input.idea.caseHint || 'BatterySOC'}"}，并写 modelica/model.mo`
          : input.idea?.problemClass === 'forecast'
            ? '2. model.json：{"engine":"pv-wind-load-forecast","kind":"pv|wind|load|energy","model":"lstm|gru|cnn|svr","variant":"v1-v5","horizon":24,"action":"predict"}'
            : input.idea?.problemClass === 'loss'
              ? '2. model.json：{"engine":"nwxs-loss","input":"loss/input.json"}'
              : input.idea?.problemClass === 'dispatch'
                ? `2. model.json：{"engine":"power-dispatch","case":"${input.idea.caseHint || 'ieee14'}"}`
                : input.idea?.problemClass === 'mgplan'
                  ? '2. model.json：{"engine":"openTEPES","case":"sSEP"}'
        : '2. model.json：标准算例用 {"case":"case24"}；.mps/.lp 用 {"engine":"esopt","mode":"mps","modelFile":"esopt/xxx.mps"}；自定义问题必须含 variables 数组与 objective',
      ['acopf', 'mgplan'].includes(String(input.idea?.problemClass))
        ? '3. result.json：status=optimal，并写出目标值'
        : ['modelica', 'forecast', 'loss', 'dispatch'].includes(String(input.idea?.problemClass))
          ? '3. result.json：status=success，并写出求解器数值'
        : '3. result.json：termination_status = 7，并写出目标值'
    ].filter((line) => line !== '').join('\n');
  }
  if (input.stageKey === 'review') {
    return [
      '# 任务',
      `只审查最优方案「${input.idea?.title || '当前方案'}」，不要并行审查其他想法。`,
      '',
      '## 审查分工',
      '- 小模型：线性性、termination_status、目标值、单位是否自洽',
      '- 大模型：模型是否表达原问题、结果是否合理、局限与风险',
      '',
      '## 依据',
      '只能引用 IDEA.md、DESIGN.md、model.json、result.json 中已经出现的内容，禁止编造数字。'
    ].join('\n');
  }
  if (input.stageKey === 'write') {
    return [
      '# 任务',
      `根据最优方案「${input.idea?.title || '当前方案'}」的模型、求解结果与双模型审查意见，撰写一份可归档的技术报告。`,
      '',
      '## 写作要求',
      '- 数字必须来自 result.json',
      '- 审查意见作为「校核记录」附录，不改写最优值',
      '- 结构至少覆盖问题、模型、求解、校核与结论'
    ].join('\n');
  }
  return input.session.seedIdea;
}

export function composeAssistantReply(input: {
  kind: 'root' | 'idea' | 'stage';
  stageKey?: SchemeStageKey;
  session: SchemeSessionSnapshot;
  idea?: SchemeIdeaView;
  artifact?: SchemeArtifactFiles | null;
  trace?: SchemeAgentTrace;
  running?: boolean;
}) {
  if (input.running) return '';
  if (input.kind === 'root') {
    const solvable = input.session.ideas.filter((item) => item.solvability === 'solvable');
    const rejected = input.session.ideas.filter((item) => item.solvability === 'rejected');
    if (!solvable.length && !rejected.length) return input.session.progressDetail || '';
    return [
      '## 头脑风暴结论',
      '',
      `我按本机可解范围筛过一轮，当前树里有 **${solvable.length} 条可研究想法**` +
        (rejected.length ? `，另有 **${rejected.length} 条不可研究**。` : '。'),
      '',
      solvable.length
        ? ['### 可研究', ...solvable.map((item, index) => `${index + 1}. **${item.title}**  \n${item.summary}${item.whySolvable ? `  \n依据：${item.whySolvable}` : ''}`)].join('\n')
        : '',
      rejected.length
        ? ['### 不可研究', ...rejected.map((item, index) => `${index + 1}. **${item.title}**  \n${item.rejectReason || item.summary}`)].join('\n')
        : '',
      '',
      '点开树上的想法节点，可以继续看该方向的决策、约束、目标和下一步流水线。'
    ].filter(Boolean).join('\n');
  }
  if (input.kind === 'idea' && input.idea) {
    const idea = input.idea;
    return [
      `## ${idea.solvability === 'rejected' ? '不可研究' : '可进入研究'}`,
      '',
      idea.summary,
      '',
      '### 问题画像',
      `- 类型：${problemClassLabel(idea.problemClass)}`,
      idea.decisions ? `- 决策：${idea.decisions}` : '',
      idea.limits ? `- 约束：${idea.limits}` : '',
      idea.goal ? `- 目标：${idea.goal}` : '',
      idea.caseHint ? `- 算例：${idea.caseHint}` : '',
      '',
      idea.solvability === 'rejected'
        ? `### 拒绝原因\n${idea.rejectReason || '未满足本机可解边界。'}`
        : `### 可研究依据\n${idea.whySolvable || '头脑风暴已将其标为可建模。'}`,
      '',
      idea.solvability === 'solvable'
        ? '若确认方向无误，可只研究这一条：设计求解会先写模型，再调用对应求解器；审查与报告仍只对全局最优方案跑一次。'
        : ''
    ].filter((line) => line !== '').join('\n');
  }
  if (input.stageKey === 'design') {
    const solve = input.idea ? stageOf(input.idea.stages, 'solve') : undefined;
    const objective = readSolveObjective(solve?.artifactJson);
    return [
      '## 设计求解纪要',
      '',
      input.trace?.output || '',
      '',
      '### 模型',
      input.artifact?.model ? `已落盘 model.json：\n\n\`\`\`json\n${excerpt(input.artifact.model, 500)}\n\`\`\`` : '模型文件尚未形成可展示内容。',
      '',
      '### 求解',
      objective != null
        ? `目标值 **${objective}**。${solve?.headline || '求解器已返回结果。'} 完整 DESIGN.md / model.json / result.json 在「数据」里。`
        : solve?.headline || '尚未拿到最优解。'
    ].filter((line) => line !== '').join('\n');
  }
  if (input.stageKey === 'review') {
    return [
      '## 审查结论',
      '',
      input.trace?.output || '',
      '',
      input.artifact?.reviewSmall ? `### 小模型形式校核\n${excerpt(input.artifact.reviewSmall, 480)}` : '',
      input.artifact?.reviewLarge ? `### 大模型工程审查\n${excerpt(input.artifact.reviewLarge, 480)}` : '',
      '',
      '完整意见可在「数据」里对照阅读。'
    ].filter((line) => line !== '').join('\n');
  }
  if (input.stageKey === 'write') {
    return [
      '## 报告撰写',
      '',
      input.trace?.output || '',
      '',
      input.artifact?.report
        ? `正文已写入 REPORT.md。开头如下：\n\n${excerpt(input.artifact.report, 520)}`
        : '报告尚未落盘。',
      '',
      '需要归档时，可直接导出 DOCX。'
    ].filter((line) => line !== '').join('\n');
  }
  return input.trace?.output || '';
}

export function liveKindFromStep(type?: string): SchemeLiveTraceItem['kind'] {
  if (type === 'plan') return 'plan';
  if (type === 'tool_call') return 'tool';
  if (type === 'observation') return 'observe';
  if (type === 'public_text' || type === 'synthesis') return 'output';
  return 'thought';
}
