import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { jsonrepair } from 'jsonrepair';
import { runOpenCodeQuestion } from './runtime';
import type { OpenCodeRunOptions, OpenCodeRunResult, RuntimeAgentStep } from './types';
import type {
  InventionDisclosure,
  PatentBlocker,
  PatentParsedSource,
  PatentProject,
  PriorArtReport
} from '@/lib/patent-generation/types';

export const PATENT_OPENCODE_SESSION_FILE = path.join(
  process.cwd(),
  'storage',
  'patent-opencode-sessions.json'
);

export function patentWorkspaceRelative(projectId: string) {
  return `patents/${projectId}/opencode`;
}

export function patentWorkspaceAbsolute(projectId: string) {
  return path.join(process.cwd(), 'storage', patentWorkspaceRelative(projectId));
}

export function patentProjectAbsolute(projectId: string) {
  return path.dirname(patentWorkspaceAbsolute(projectId));
}

export function formatPatentUserAnswers(input: {
  applicant?: string;
  inventors?: string[];
  blockers?: PatentBlocker[];
  answers?: Record<string, string>;
}) {
  const lines: string[] = [];
  // 仅当用户已通过 OpenCode 提问并答复后，才写入“已确认”身份；解析候选放在 META.json。
  const inventorsConfirmed = Boolean(input.answers?.['confirm-inventors']?.trim())
    || (input.blockers || []).some((blocker) => blocker.id === 'confirm-inventors' && blocker.resolved && blocker.answer?.trim());
  const applicantConfirmed = Boolean(input.answers?.['confirm-applicant']?.trim())
    || (input.blockers || []).some((blocker) => blocker.id === 'confirm-applicant' && blocker.resolved && blocker.answer?.trim());
  if (applicantConfirmed && input.applicant?.trim()) {
    lines.push(`申请人（已确认）：${input.applicant.trim()}`);
  }
  if (inventorsConfirmed && input.inventors?.length) {
    lines.push(`发明人（已确认）：${input.inventors.join('、')}`);
  }
  const answered = (input.blockers || [])
    .filter((blocker) => blocker.resolved && blocker.answer?.trim())
    .map((blocker) => `- [${blocker.severity}/${blocker.category}] ${blocker.question}\n  答复：${blocker.answer}`);
  const looseAnswers = Object.entries(input.answers || {})
    .filter(([id, value]) => value.trim() && !(input.blockers || []).some((blocker) => blocker.id === id && blocker.answer?.trim()))
    .map(([id, value]) => `- [${id}] ${value.trim()}`);
  if (answered.length) lines.push(`已确认问题：\n${answered.join('\n')}`);
  if (looseAnswers.length) lines.push(`补充答复：\n${looseAnswers.join('\n')}`);
  return lines.join('\n') || '无用户确认答复（解析候选见 META.json，须由 patent-clarification 主动确认）';
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(filePath: string, content: string) {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, filePath);
}

function writeJson(filePath: string, value: unknown) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function buildPatentSourceMarkdown(parsed: PatentParsedSource) {
  const parts = [
    `# 技术交底原文`,
    '',
    parsed.text || '',
    '',
    '## 解析元数据',
    '',
    `- 标题：${parsed.metadata.title || '未知'}`,
    `- 公式对象：${parsed.formulaObjectsRecovered}/${parsed.formulaObjectsDetected}`,
    `- 表格：${parsed.tables.length}`,
    `- 附图：${parsed.figures.length}`,
    `- 警告：${parsed.warnings.join('；') || '无'}`,
    ''
  ];
  if (parsed.tables.length) {
    parts.push('## 表格摘要', '');
    for (const table of parsed.tables.slice(0, 20)) {
      parts.push(`### ${table.caption || table.id}`);
      parts.push(table.rows.slice(0, 12).map((row) => row.join(' | ')).join('\n'));
      parts.push('');
    }
  }
  if (parsed.formulas.length) {
    parts.push('## 公式目录', '');
    for (const formula of parsed.formulas.slice(0, 40)) {
      parts.push(`- ${formula.id}: ${formula.latex || '(未恢复)'} (${formula.confidence})`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

export function preparePatentOpenCodeWorkspace(input: {
  project: PatentProject;
  priorArt?: PriorArtReport | null;
}) {
  const { project } = input;
  if (!project.source?.parsed) throw new Error('缺少解析后的技术交底。');
  const dir = patentWorkspaceAbsolute(project.id);
  ensureDir(dir);

  writeText(path.join(dir, 'SOURCE.md'), buildPatentSourceMarkdown(project.source.parsed));
  writeJson(path.join(dir, 'META.json'), {
    projectId: project.id,
    title: project.title,
    // 解析候选 ≠ 用户确认；身份确认由 OpenCode clarification 提问。
    applicantCandidate: project.applicant || project.source.parsed.metadata.applicant || '',
    inventorCandidates: project.inventors?.length
      ? project.inventors
      : (project.source.parsed.metadata.authors || []),
    organizations: project.source.parsed.metadata.organizations || [],
    contact: project.contact
  });
  writeText(
    path.join(dir, 'ANSWERS.md'),
    formatPatentUserAnswers({
      applicant: project.applicant,
      inventors: project.inventors,
      blockers: project.blockers,
      answers: project.answers
    })
  );

  const priorArt = input.priorArt || project.priorArt;
  if (priorArt) {
    writeJson(path.join(dir, 'PRIOR_ART.json'), priorArt);
  }

  // Seed existing DB artifacts so the agent can resume instead of rewriting.
  if (project.disclosure) writeJson(path.join(dir, 'disclosure.json'), project.disclosure);
  if (project.clarification) writeJson(path.join(dir, 'clarification.json'), project.clarification);
  if (project.strategy) writeJson(path.join(dir, 'strategy.json'), project.strategy);
  if (project.draft?.claims) writeText(path.join(dir, 'claims.txt'), project.draft.claims);
  if (project.draft) writeJson(path.join(dir, 'draft.json'), project.draft);
  if (project.audit) writeJson(path.join(dir, 'audit.json'), project.audit);
  if (project.drawings?.assets?.some((asset) => asset.diagram)) {
    writeJson(path.join(dir, 'drawings-plan.json'), {
      diagrams: project.drawings.assets
        .filter((asset) => asset.diagram)
        .map((asset) => asset.diagram)
    });
  }

  return {
    absoluteDir: dir,
    relativeDir: 'opencode'
  };
}

/**
 * OpenCode 偶发把长字段写成 JS 模板字符串（反引号），或过早关闭对象：
 *   "name": "..." },
 *   "description": "..."
 * 先做结构修补，再尝试 jsonrepair。
 */
export function repairWorkspaceJsonText(raw: string): string {
  let text = raw.replace(/^\uFEFF/, '');
  text = text.replace(/:\s*`([\s\S]*?)`(\s*[,}\]])/g, (_match, body: string, tail: string) => (
    `: ${JSON.stringify(body)}${tail}`
  ));
  // OpenCode 偶发把 `:` 写成 `>`，例如 `"label">"电力输入"`。
  text = text.replace(/("(?:\\.|[^"\\])*")\s*>\s*"/g, '$1: "');
  // 以及把 `":"` 写成 `","`，例如 `"to","N4"`。
  text = text.replace(
    /"(from|to|id|label|ref|kind|title|name|figureNumber)"\s*,\s*"/g,
    '"$1": "'
  );
  // 对象字段写完 name/id 后误写 `},`，把后续同级字段挤出对象外。
  const continuedKeys = [
    'description',
    'essential',
    'technicalEffect',
    'anchors',
    'reason',
    'question',
    'options',
    'evidence',
    'note',
    'message',
    'suggestion',
    'category',
    'severity',
    'answer',
    'id',
    'name',
    'type',
    'scope',
    'purpose',
    'featureIds',
    'essentialFeatureIds',
    'parentType',
    'quote',
    'section',
    'figureNumber',
    'label',
    'kind',
    'supported',
    'claim',
    'title',
    'content'
  ].join('|');
  text = text.replace(
    new RegExp(
      `("(?:\\\\.|[^"\\\\])*")\\s*\\}\\s*,\\s*\\n(\\s*"(?:${continuedKeys})"\\s*:)`,
      'g'
    ),
    '$1,\n$2'
  );
  // 同模式的单行变体
  text = text.replace(
    new RegExp(
      `("(?:\\\\.|[^"\\\\])*")\\s*\\}\\s*,\\s*("(?:${continuedKeys})"\\s*:)`,
      'g'
    ),
    '$1, $2'
  );
  return text;
}

export function parseWorkspaceJsonText<T = unknown>(raw: string): { value: T; repaired: boolean } | null {
  const repaired = repairWorkspaceJsonText(raw);
  const attempts = [raw, repaired];
  for (const [index, attempt] of attempts.entries()) {
    try {
      return { value: JSON.parse(attempt) as T, repaired: index > 0 || attempt !== raw };
    } catch {
      try {
        return { value: JSON.parse(jsonrepair(attempt)) as T, repaired: true };
      } catch {
        // try next candidate
      }
    }
  }
  return null;
}

function normalizeDraftWorkspaceShape(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const draft = { ...(value as Record<string, unknown>) };
  if (Array.isArray(draft.drawingDescription)) {
    draft.drawingDescription = draft.drawingDescription.map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const row = item as Record<string, unknown>;
        if (row.figureNumber != null && typeof row.description === 'string') {
          return `图${row.figureNumber}：${row.description.trim()}`;
        }
        if (typeof row.description === 'string') return row.description.trim();
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  return draft;
}

export function readPatentWorkspaceJson<T = unknown>(projectId: string, fileName: string): T | null {
  const filePath = path.join(patentWorkspaceAbsolute(projectId), fileName);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = parseWorkspaceJsonText<T>(raw);
  if (!parsed) return null;
  const value = fileName === 'draft.json'
    ? normalizeDraftWorkspaceShape(parsed.value) as T
    : parsed.value;
  const shouldRewrite = parsed.repaired || (fileName === 'draft.json' && value !== parsed.value);
  if (shouldRewrite) {
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } catch {
      // best-effort rewrite; in-memory parse still succeeds
    }
  }
  return value;
}

export function readPatentWorkspaceText(projectId: string, fileName: string): string | null {
  const filePath = path.join(patentWorkspaceAbsolute(projectId), fileName);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

export type PatentWorkspaceStatus = {
  status: 'needs_input' | 'ready' | 'failed' | 'running' | string;
  error?: string;
};

export function readPatentWorkspaceStatus(projectId: string): PatentWorkspaceStatus | null {
  return readPatentWorkspaceJson<PatentWorkspaceStatus>(projectId, 'STATUS.json');
}

/**
 * OpenCode 偶发写完 disclosure/blockers 却漏写 STATUS.json。
 * 根据工作区产物回填，避免流水线误判“交底分析未完成”。
 */
export function recoverPatentWorkspaceStatus(projectId: string): PatentWorkspaceStatus | null {
  const existing = readPatentWorkspaceStatus(projectId);
  if (existing?.status) return existing;

  const blockers = coerceWorkspaceBlockers(readPatentWorkspaceJson(projectId, 'blockers.json'));
  const hasOpenP0 = blockers.some(
    (item) => item.severity === 'P0' && !item.resolved && !String(item.answer || '').trim()
  );
  if (hasOpenP0) {
    const recovered = { status: 'needs_input', note: 'auto-recovered-from-blockers' };
    writePatentWorkspaceJson(projectId, 'STATUS.json', recovered);
    return recovered;
  }

  const disclosure = readPatentWorkspaceJson(projectId, 'disclosure.json');
  const draft = readPatentWorkspaceJson(projectId, 'draft.json');
  const audit = readPatentWorkspaceJson(projectId, 'audit.json');
  if (draft && audit) {
    const recovered = { status: 'ready', note: 'auto-recovered-from-draft' };
    writePatentWorkspaceJson(projectId, 'STATUS.json', recovered);
    return recovered;
  }
  if (disclosure) {
    const recovered = { status: 'clarified', note: 'auto-recovered-from-disclosure' };
    writePatentWorkspaceJson(projectId, 'STATUS.json', recovered);
    return recovered;
  }
  return null;
}

export function formatPatentAgentStepDetail(prefix: string, step: RuntimeAgentStep): string {
  const content = String(step.content || '').replace(/\s+/g, ' ').trim();
  if (
    step.type === 'public_text'
    || step.type === 'thought'
    || step.type === 'plan'
    || step.type === 'synthesis'
  ) {
    return (content || `${prefix}进行中…`).slice(0, 180);
  }
  if (step.type === 'observation') {
    const tool = step.tool ? `${step.tool} ` : '';
    return `${prefix}${tool}${content || '已完成'}`.slice(0, 180);
  }
  if (step.tool) {
    if (content && !/^调用\s+/i.test(content)) {
      return `${prefix}${content}`.slice(0, 180);
    }
    const input = step.input || {};
    const target = String(
      input.name || input.skill || input.path || input.filePath || input.pattern || input.query || ''
    ).trim();
    return (target ? `${prefix}${step.tool} ${target}` : `${prefix}${step.tool}`).slice(0, 180);
  }
  return (content || `${prefix}进行中…`).slice(0, 180);
}

const PATENT_TOOL_POLICY = {
  read: true,
  list: true,
  glob: true,
  grep: true,
  bash: false,
  edit: true,
  write: true,
  skill: true,
  task: false,
  webfetch: false,
  websearch: false,
  todowrite: false,
  lsp: false
} as const;

function buildPatentPrompt(relativeDir: string, resume: boolean) {
  const pathRules = [
    `工作区相对路径（相对当前专利项目目录）：${relativeDir}/`,
    '只用 list/read/write/edit/glob/grep/skill；禁止 bash。',
    `读写必须用相对路径，例如 ${relativeDir}/STATUS.json 、 ${relativeDir}/SOURCE.md 。`,
    '禁止绝对路径、..、符号链接以及访问当前项目目录之外的任何文件。'
  ].join('\n');
  const qualityBar = [
    '质量硬门槛（写 ready 前自检）：',
    '- 权利要求数量和客体类型由技术贡献决定，禁止为凑数量增加无来源特征；',
    '- 摘要 ≤300 汉字；实施例须足以实施全部必要技术特征；',
    '- 数学公式必须写成 LaTeX，并用 $...$（行内）或 $$...$$（独立成行）包裹，禁止纯文本伪公式；',
    '- 附图数量由方案需要决定，节点 label 简明且不得改变技术含义；',
    '- audit.json 不得残留 severity=error。',
    '流程硬门槛：有未解决 P0（身份、关键技术事实）必须 needs_input 停止，不得用占位信息硬写。'
  ].join('\n');
  if (resume) {
    return [
      '继续完成中国发明专利申请草稿：质量优先，保留澄清与审校。',
      pathRules,
      qualityBar,
      '先 list/read 工作区现有文件与 ANSWERS.md、STATUS.json；若存在 QUALITY_REPORT.json 则按其修复。',
      '根据 ANSWERS 吸收用户答复，从尚未完成的步骤继续；不要无故删除已有合格产物。',
      '必须按需加载 patent-* skills，并把结果写入约定文件。',
      '仍有未解决 P0 时写 STATUS.json=needs_input 并停止；齐备且审校通过后写 ready；失败写 failed。'
    ].join('\n');
  }
  return [
    '请基于已经完成的交底澄清和现有技术候选，生成高质量中国发明专利申请草稿。',
    pathRules,
    qualityBar,
    '已为你准备 SOURCE.md、META.json、ANSWERS.md、disclosure.json、clarification.json、PRIOR_ART.json。',
    '先核对 clarification.readyForDrafting 且不存在未解决 P0；然后按 patent-strategy → patent-claims → patent-drawings → patent-specification → patent-audit 顺序执行。',
    '每步用 skill 工具加载对应 skill，并把 JSON/文本写入工作区约定文件名。',
    '最终更新 STATUS.json。过程思考要多写几段（目标、证据、缺口、下一步）；最终确认仍用一句中文。'
  ].join('\n');
}

function buildPatentClarificationPrompt(relativeDir: string, resume: boolean) {
  return [
    resume ? '继续完成中国发明专利交底分析与必要澄清。' : '仅执行中国发明专利的交底分析与必要澄清。',
    `工作区相对路径（相对当前专利项目目录）：${relativeDir}/`,
    '只用 list/read/write/edit/glob/grep/skill；禁止 bash。',
    `先读取 ${relativeDir}/SOURCE.md、META.json、ANSWERS.md。`,
    '依次加载 patent-disclosure 与 patent-clarification，写 disclosure.json、clarification.json。',
    '必须确认申请人和发明人候选；其他问题只保留会影响必要技术特征或可实施性的关键事实。',
    '有未解决 P0：写 blockers.json 与 STATUS.json={"status":"needs_input"} 后停止。',
    '无未解决 P0：写 blockers.json=[]（必须是空数组，禁止 {}），并写 STATUS.json={"status":"clarified"} 后停止。',
    '本轮禁止执行现有技术检索、权利要求撰写、说明书撰写和审校。过程思考要多写几段（目标、证据、缺口、下一步）；最终确认仍用一句中文。'
  ].join('\n');
}

export const PATENT_REVIEW_ANGLES = [
  {
    id: 'form_support',
    label: '形式与支持',
    focus: [
      '清楚性、简要性、摘要篇幅与摘要附图',
      '权利要求引用关系、独立/从属结构、一句一项',
      '说明书各节对权利要求的支持与附图说明完整性'
    ]
  },
  {
    id: 'sufficiency',
    label: '充分公开与可实施',
    focus: [
      '具体实施方式是否足以实施全部必要技术特征',
      '关键公式/变量定义/数据流/约束是否清楚可复现',
      '实施例完整性、参数示例是否与保护范围区分开'
    ]
  },
  {
    id: 'inventiveness_claims',
    label: '创造性与保护范围',
    focus: [
      '与 PRIOR_ART 的客观区别特征及非显而易见性表述',
      '独立权利要求保护范围是否适当、有无缺少必要特征或写入过多细节',
      '单一性、客体适格、不当新增内容、回退布局'
    ]
  }
] as const;

export type PatentReviewAngleId = (typeof PATENT_REVIEW_ANGLES)[number]['id'];

function buildPatentRepairPrompt(relativeDir: string) {
  return [
    '请根据工作区 QUALITY_REPORT.json 修复中国发明专利申请草稿，目标仍是直接可交付。',
    `工作区相对路径（相对当前专利项目目录）：${relativeDir}/`,
    '只用 list/read/write/edit/glob/grep/skill；禁止 bash。',
    '先 read QUALITY_REPORT.json 与现有 draft.json、claims.txt、drawings-plan.json、audit.json。',
    '只修复报告中的问题；可按需加载 patent-claims / patent-drawings / patent-specification / patent-audit。',
    '修复后重新自检，清除 audit.json 中的 error，写入 STATUS.json={"status":"ready"}。',
    '过程思考要多写几段（目标、证据、缺口、下一步）；最终确认仍用一句中文。'
  ].join('\n');
}

function buildPatentReviewRoundPrompt(input: {
  relativeDir: string;
  round: number;
  totalRounds: number;
  angleId: PatentReviewAngleId;
  angleLabel: string;
  focus: readonly string[];
}) {
  return [
    `这是第 ${input.round}/${input.totalRounds} 轮专业审校与修订。`,
    `本轮审查角度：${input.angleLabel}（${input.angleId}）。`,
    `工作区相对路径（相对当前专利项目目录）：${input.relativeDir}/`,
    '只用 list/read/write/edit/glob/grep/skill；禁止 bash。',
    '先 read QUALITY_REPORT.json、PRIOR_ART.json、disclosure.json、strategy.json、draft.json、claims.txt、audit.json。',
    '必须加载 patent-audit skill，并按本轮角度做专业审查（不要只做结构清单打勾）。',
    `本轮重点：\n${input.focus.map((item) => `- ${item}`).join('\n')}`,
    '对发现的 error 与会实质影响授权/保护的 warning：立即修订 draft.json 和/或 claims.txt（必要时改 drawings-plan.json）。',
    '写回完整 audit.json：issues / supportMatrix / remainingRisks；并额外写入 audit-round-' + input.round + '.json 副本。',
    'issues 须体现本轮角度的实质问题或“已修复”记录，禁止空审或只写格式通过。',
    '完成后写 STATUS.json={"status":"ready"}。过程思考要多写几段（目标、证据、缺口、下一步）；最终确认仍用一句中文。'
  ].join('\n');
}

export function writePatentWorkspaceJson(projectId: string, fileName: string, value: unknown) {
  writeJson(path.join(patentWorkspaceAbsolute(projectId), fileName), value);
}

export async function runOpenCodePatentGeneration(input: {
  projectId: string;
  relativeDir: string;
  resume?: boolean;
  signal?: AbortSignal;
  onStatus?: OpenCodeRunOptions['onStatus'];
  onStep?: (step: RuntimeAgentStep) => void | Promise<void>;
}): Promise<OpenCodeRunResult> {
  return runOpenCodeQuestion(buildPatentPrompt(input.relativeDir, Boolean(input.resume)), {
    conversationId: `patent:${input.projectId}`,
    sessionTitle: '专利生成',
    sessionMapFile: PATENT_OPENCODE_SESSION_FILE,
    workingDirectory: patentProjectAbsolute(input.projectId),
    agent: 'patent-drafter',
    skipCorpusCheck: true,
    rawPrompt: true,
    timeoutMs: 25 * 60 * 1000,
    tools: { ...PATENT_TOOL_POLICY },
    signal: input.signal,
    onStatus: input.onStatus,
    onStep: input.onStep
  });
}

export async function runOpenCodePatentClarification(input: {
  projectId: string;
  relativeDir: string;
  resume?: boolean;
  signal?: AbortSignal;
  onStatus?: OpenCodeRunOptions['onStatus'];
  onStep?: (step: RuntimeAgentStep) => void | Promise<void>;
}): Promise<OpenCodeRunResult> {
  return runOpenCodeQuestion(
    buildPatentClarificationPrompt(input.relativeDir, Boolean(input.resume)),
    {
      conversationId: `patent:${input.projectId}`,
      sessionTitle: '专利交底澄清',
      sessionMapFile: PATENT_OPENCODE_SESSION_FILE,
      workingDirectory: patentProjectAbsolute(input.projectId),
      agent: 'patent-drafter',
      skipCorpusCheck: true,
      rawPrompt: true,
      timeoutMs: 15 * 60 * 1000,
      tools: { ...PATENT_TOOL_POLICY },
      signal: input.signal,
      onStatus: input.onStatus,
      onStep: input.onStep
    }
  );
}

export async function runOpenCodePatentRepair(input: {
  projectId: string;
  relativeDir: string;
  signal?: AbortSignal;
  onStatus?: OpenCodeRunOptions['onStatus'];
  onStep?: (step: RuntimeAgentStep) => void | Promise<void>;
}): Promise<OpenCodeRunResult> {
  return runOpenCodeQuestion(buildPatentRepairPrompt(input.relativeDir), {
    conversationId: `patent:${input.projectId}`,
    sessionTitle: '专利质检修复',
    sessionMapFile: PATENT_OPENCODE_SESSION_FILE,
    workingDirectory: patentProjectAbsolute(input.projectId),
    agent: 'patent-drafter',
    skipCorpusCheck: true,
    rawPrompt: true,
    timeoutMs: 12 * 60 * 1000,
    tools: { ...PATENT_TOOL_POLICY },
    signal: input.signal,
    onStatus: input.onStatus,
    onStep: input.onStep
  });
}

function buildPatentSchemaRepairPrompt(input: {
  relativeDir: string;
  fileName: string;
  issuesText: string;
  attempt: number;
  maxAttempts: number;
}) {
  return [
    `工作区 JSON 结构校验失败，请按错误修复（第 ${input.attempt}/${input.maxAttempts} 次）。`,
    `工作区相对路径（相对当前专利项目目录）：${input.relativeDir}/`,
    '只用 list/read/write/edit/glob/grep/skill；禁止 bash。',
    `必须先 read ${input.relativeDir}/SCHEMA_VALIDATION.json 与 ${input.relativeDir}/${input.fileName}。`,
    `只重写 ${input.fileName}：保持技术语义，修正字段类型/枚举/数组形态/JSON 语法。`,
    '枚举只能用系统允许值；例如独立权利要求 type 仅可为 method / system / device / storage_medium（勿写 computer_storage_medium）。',
    'blockers.json 无问题时必须是 []；禁止写成 {}。',
    '字符串数组的元素必须是字符串，禁止对象元素。',
    '写入合法 JSON，不要 Markdown 代码块。',
    '校验错误摘要如下（完整见 SCHEMA_VALIDATION.json）：',
    input.issuesText.slice(0, 3500),
    '修完后覆盖写回目标文件即可；过程思考要多写几段（目标、证据、缺口、下一步）；最终确认仍用一句中文。'
  ].join('\n');
}

/** 契约校验失败时：把 Zod/解析错误喂回模型，只改指定产物文件。 */
export async function runOpenCodePatentSchemaRepair(input: {
  projectId: string;
  relativeDir: string;
  fileName: string;
  issuesText: string;
  attempt: number;
  maxAttempts: number;
  signal?: AbortSignal;
  onStatus?: OpenCodeRunOptions['onStatus'];
  onStep?: (step: RuntimeAgentStep) => void | Promise<void>;
}): Promise<OpenCodeRunResult> {
  return runOpenCodeQuestion(
    buildPatentSchemaRepairPrompt({
      relativeDir: input.relativeDir,
      fileName: input.fileName,
      issuesText: input.issuesText,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts
    }),
    {
      conversationId: `patent:${input.projectId}`,
      sessionTitle: `专利结构修复:${input.fileName}`,
      sessionMapFile: PATENT_OPENCODE_SESSION_FILE,
      workingDirectory: patentProjectAbsolute(input.projectId),
      agent: 'patent-drafter',
      skipCorpusCheck: true,
      rawPrompt: true,
      timeoutMs: 10 * 60 * 1000,
      tools: { ...PATENT_TOOL_POLICY },
      signal: input.signal,
      onStatus: input.onStatus,
      onStep: input.onStep
    }
  );
}

export async function runOpenCodePatentReviewRound(input: {
  projectId: string;
  relativeDir: string;
  round: number;
  totalRounds: number;
  angleId: PatentReviewAngleId;
  angleLabel: string;
  focus: readonly string[];
  signal?: AbortSignal;
  onStatus?: OpenCodeRunOptions['onStatus'];
  onStep?: (step: RuntimeAgentStep) => void | Promise<void>;
}): Promise<OpenCodeRunResult> {
  return runOpenCodeQuestion(
    buildPatentReviewRoundPrompt({
      relativeDir: input.relativeDir,
      round: input.round,
      totalRounds: input.totalRounds,
      angleId: input.angleId,
      angleLabel: input.angleLabel,
      focus: input.focus
    }),
    {
      conversationId: `patent:${input.projectId}`,
      sessionTitle: `专利审校第${input.round}轮`,
      sessionMapFile: PATENT_OPENCODE_SESSION_FILE,
      workingDirectory: patentProjectAbsolute(input.projectId),
      agent: 'patent-drafter',
      skipCorpusCheck: true,
      rawPrompt: true,
      timeoutMs: 15 * 60 * 1000,
      tools: { ...PATENT_TOOL_POLICY },
      signal: input.signal,
      onStatus: input.onStatus,
      onStep: input.onStep
    }
  );
}

function coerceWorkspaceBlockers(
  workspaceBlockers: unknown
): Array<Partial<PatentBlocker>> {
  if (Array.isArray(workspaceBlockers)) {
    return workspaceBlockers.filter((item) => item && typeof item === 'object') as Array<Partial<PatentBlocker>>;
  }
  if (workspaceBlockers && typeof workspaceBlockers === 'object') {
    const record = workspaceBlockers as Record<string, unknown>;
    for (const key of ['blockers', 'items', 'stillMissing', 'questions', 'list']) {
      if (Array.isArray(record[key])) {
        return coerceWorkspaceBlockers(record[key]);
      }
    }
    // OpenCode 偶发写 {} 表示“无 blockers”
    if (Object.keys(record).length === 0) return [];
  }
  return [];
}

export function mergeWorkspaceBlockers(
  project: PatentProject,
  workspaceBlockers: unknown,
  disclosure?: InventionDisclosure | null
): PatentBlocker[] {
  const existing = new Map(project.blockers.map((blocker) => [blocker.id, blocker]));
  const blockerId = (prefix: string, question: string) =>
    `${prefix}-${crypto.createHash('sha256').update(question.trim()).digest('hex').slice(0, 10)}`;
  const severityOf = (value: unknown): PatentBlocker['severity'] => {
    const raw = String(value || '').trim().toUpperCase();
    if (['P0', 'CRITICAL', 'HIGH', 'ERROR', '严重'].includes(raw)) return 'P0';
    if (['P2', 'LOW', 'INFO', '提示'].includes(raw)) return 'P2';
    return 'P1';
  };
  const categoryOf = (value: unknown): PatentBlocker['category'] => {
    const raw = String(value || '').trim();
    return ['identity', 'source', 'formula', 'technical', 'evidence', 'legal'].includes(raw)
      ? raw as PatentBlocker['category']
      : 'technical';
  };
  const fromWorkspace = coerceWorkspaceBlockers(workspaceBlockers)
    .filter((item) => String(item.question || '').trim());
  fromWorkspace.forEach((item, index) => {
    const question = String(item.question || '').trim();
    const id = item.id?.trim() || blockerId('clarify', question || String(index));
    const previous = existing.get(id);
    existing.set(id, {
      id,
      severity: severityOf(item.severity),
      category: categoryOf(item.category),
      question,
      reason: String(item.reason || '').trim(),
      resolved: previous?.resolved || Boolean(project.answers[id]?.trim()),
      answer: previous?.answer || project.answers[id] || String(item.answer || '').trim() || undefined
    });
  });
  if (disclosure?.missingInformation?.length) {
    disclosure.missingInformation.forEach((item, index) => {
      if (!item.question.trim()) return;
      const id = blockerId('technical', item.question || String(index));
      const previous = existing.get(id);
      existing.set(id, {
        id,
        severity: item.severity,
        category: 'technical',
        question: item.question,
        reason: item.reason,
        resolved: previous?.resolved || Boolean(project.answers[id]?.trim()),
        answer: previous?.answer || project.answers[id]
      });
    });
  }
  return [...existing.values()];
}
