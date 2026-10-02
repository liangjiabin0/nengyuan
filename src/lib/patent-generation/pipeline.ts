import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  formatPatentAgentStepDetail,
  formatPatentUserAnswers,
  mergeWorkspaceBlockers,
  PATENT_REVIEW_ANGLES,
  preparePatentOpenCodeWorkspace,
  readPatentWorkspaceJson,
  readPatentWorkspaceStatus,
  readPatentWorkspaceText,
  recoverPatentWorkspaceStatus,
  runOpenCodePatentClarification,
  runOpenCodePatentGeneration,
  runOpenCodePatentReviewRound,
  writePatentWorkspaceJson
} from '@/lib/opencode/patent';
import {
  buildFallbackDiagramSpecs,
  drawingDescriptionFromAssets,
  extractSourceFigures,
  persistGeneratedDiagrams
} from './figures';
import {
  loadWorkspaceArtifactWithRetry,
  parseLooseJson
} from './schema-retry';
import { searchPatentPriorArt } from './prior-art';
import {
  getPatentProject,
  getPatentProjectDirectory,
  getPatentSourceRow,
  savePatentArtifact,
  setPatentProgress
} from './store';
import type {
  AuditIssue,
  ClaimStrategy,
  InventionDisclosure,
  PatentAudit,
  PatentBlocker,
  PatentDiagramSpec,
  PatentDraft,
  PatentDrawingAsset,
  PatentProgressEvent,
  PatentProject,
  PatentStage,
  PriorArtReport
} from './types';
import { mergeModelAudit, normalizeClaimsText, validatePatentDraft } from './validators';

/** 专业审校最少轮次；分数达标且无 error 时可提前结束。 */
const PATENT_REVIEW_MIN_ROUNDS = 3;
const PATENT_REVIEW_SKIP_SCORE = 92;

/** 模型常把 string[] 项写成对象；统一压成可读字符串。 */
function coerceToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(coerceToText).filter(Boolean).join('；');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.figureNumber != null && typeof record.description === 'string' && record.description.trim()) {
      return `图${record.figureNumber}：${record.description.trim()}`;
    }
    for (const key of [
      'text',
      'description',
      'position',
      'content',
      'summary',
      'purpose',
      'scope',
      'reason',
      'risk',
      'message',
      'question',
      'feature',
      'value',
      'label',
      'name'
    ]) {
      const hit = record[key];
      if (typeof hit === 'string' && hit.trim()) {
        const mitigation = typeof record.mitigation === 'string' && record.mitigation.trim()
          ? `（缓解：${record.mitigation.trim()}）`
          : '';
        return `${hit.trim()}${mitigation}`;
      }
    }
    const parts = Object.entries(record)
      .filter(([, item]) => typeof item === 'string' && item.trim())
      .map(([key, item]) => `${key}：${String(item).trim()}`);
    if (parts.length) return parts.join('；');
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

const textItemSchema = z.unknown().transform(coerceToText);
const longTextSchema = z.unknown().transform((value) => {
  if (Array.isArray(value)) return value.map(coerceToText).filter(Boolean).join('\n\n');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([, item]) => coerceToText(item))
      .filter(Boolean)
      .join('\n\n');
  }
  return coerceToText(value);
});
const textListSchema = z
  .preprocess((value) => {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    return [value];
  }, z.array(textItemSchema))
  .default([]);

const featureSchema = z.object({
  id: z.string().default(''),
  name: z.string().default(''),
  description: z.string().default(''),
  essential: z.boolean().default(false),
  technicalEffect: z.string().default(''),
  anchors: textListSchema
});

const disclosureSchema = z.object({
  proposedTitle: z.string().default(''),
  technicalField: z.string().default(''),
  background: z.string().default(''),
  technicalProblems: textListSchema,
  inventiveConcept: z.string().default(''),
  essentialFeatures: z.array(featureSchema).default([]),
  optionalFeatures: z.array(featureSchema).default([]),
  inputs: textListSchema,
  outputs: textListSchema,
  constraints: textListSchema,
  technicalEffects: textListSchema,
  embodiments: textListSchema,
  figureSuggestions: textListSchema,
  sourceAnchors: z.array(z.object({
    id: z.string().default(''),
    quote: z.string().default(''),
    section: z.string().optional()
  })).default([]),
  assumptions: textListSchema,
  missingInformation: z.array(z.object({
    severity: z.enum(['P0', 'P1', 'P2']).default('P1'),
    question: z.string().default(''),
    reason: z.string().default('')
  })).default([])
});

const clarificationSchema = z.object({
  readyForDrafting: z.boolean().default(false),
  supplementaryFacts: textListSchema,
  stillMissing: z.array(z.object({
    severity: z.enum(['P0', 'P1', 'P2']).default('P0'),
    question: z.string().default(''),
    reason: z.string().default(''),
    options: textListSchema
  })).default([])
});

const CLAIM_TYPES = ['method', 'system', 'device', 'storage_medium'] as const;
type ClaimType = (typeof CLAIM_TYPES)[number];

/** OpenCode 常写 computer_storage_medium / apparatus 等别名，入库前归一。 */
function coerceClaimType(value: unknown, fallback: ClaimType = 'method'): ClaimType {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((CLAIM_TYPES as readonly string[]).includes(raw)) return raw as ClaimType;
  if (/method|方法|工艺|步骤/.test(raw)) return 'method';
  if (/system|系统|平台/.test(raw)) return 'system';
  if (/device|apparatus|装置|设备|终端/.test(raw)) return 'device';
  if (/storage|medium|介质|载体|计算机|computer|program|程序|readable/.test(raw)) {
    return 'storage_medium';
  }
  return fallback;
}

const claimTypeSchema = z.unknown().transform((value) => coerceClaimType(value, 'method'));

const strategySchema = z.object({
  inventionTitle: z.string().default(''),
  coreContribution: z.string().default(''),
  objectiveTechnicalProblem: z.string().default(''),
  distinguishingFeatures: textListSchema,
  nonObviousnessReasoning: textListSchema,
  independentClaims: z.array(z.object({
    type: claimTypeSchema,
    scope: z.string().default(''),
    essentialFeatureIds: textListSchema
  })).default([]),
  dependentClaimPlan: z.array(z.object({
    parentType: z.unknown().transform((value) => coerceClaimType(value, 'method')),
    featureIds: textListSchema,
    purpose: z.string().default('')
  })).default([]),
  fallbackPositions: textListSchema,
  excludedMatter: textListSchema
});

const draftSchema = z.object({
  title: textItemSchema.default(''),
  abstract: textItemSchema.default(''),
  abstractFigure: textItemSchema.default('无'),
  claims: longTextSchema.default(''),
  technicalField: longTextSchema.default(''),
  backgroundArt: longTextSchema.default(''),
  inventionSummary: longTextSchema.default(''),
  drawingDescription: longTextSchema.default(''),
  embodiments: longTextSchema.default('')
});

const diagramPlanSchema = z.object({
  diagrams: z.array(z.object({
    figureNumber: z.number().int().positive().default(1),
    title: z.string().default(''),
    kind: z.enum(['flowchart', 'block', 'structure']).default('flowchart'),
    nodes: z.array(z.object({
      id: z.string().default(''),
      label: z.string().default(''),
      ref: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional()
    })).default([]),
    edges: z.array(z.object({
      from: z.string().default(''),
      to: z.string().default(''),
      label: z.string().optional()
    })).default([]),
    notes: textListSchema
  })).default([])
});

/** OpenCode 常写 fixed/P0/high 等非标准 severity，解析前归一。 */
function coerceAuditSeverity(value: unknown): 'error' | 'warning' | 'info' {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'warning';
  if (['error', 'err', 'p0', 'critical', 'fatal', 'high', '严重', '错误'].includes(raw)) {
    return 'error';
  }
  if (['warning', 'warn', 'p1', 'medium', '中', '警告'].includes(raw)) {
    return 'warning';
  }
  if (
    ['info', 'information', 'note', 'p2', 'low', 'fixed', 'resolved', 'ok', 'pass', '提示', '已修复'].includes(raw)
  ) {
    return 'info';
  }
  return 'warning';
}

const auditSeveritySchema = z.preprocess(
  coerceAuditSeverity,
  z.enum(['error', 'warning', 'info'])
);

const modelAuditSchema = z.object({
  issues: z.array(z.object({
    id: z.string().default(''),
    severity: auditSeveritySchema.default('warning'),
    category: z.string().default('review'),
    message: z.string().default(''),
    location: z.string().optional(),
    suggestion: z.string().optional()
  })).default([]),
  supportMatrix: z.array(z.object({
    claim: z.coerce.number().int().positive(),
    supported: z.preprocess((value) => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', 'yes', '1', 'y'].includes(normalized)) return true;
        if (['false', 'no', '0', 'n'].includes(normalized)) return false;
      }
      return value;
    }, z.boolean()),
    evidence: textListSchema,
    note: z.string().default('')
  }).passthrough()).default([]),
  remainingRisks: textListSchema
});

export function canAutoResolvePatentQuestion(question: string, reason = '') {
  const text = `${question} ${reason}`;
  // 身份、实测参数等必须由用户确认；公式/公知原理类可由系统上位处理而不打断。
  const requiresActualFact = /实际(?:采用|选用|部署|测得|配置)|实测|实验结果|设备型号|申请人|发明人|权利归属|独占参数/.test(text);
  if (requiresActualFact) return false;
  return /公式|方程|数学模型|数学表达式|变量定义|符号定义|差分|守恒关系|目标函数|约束公式|热力学|热阻.?热容|排队论|通用.{0,8}原理|公知.{0,8}原理|上位概括|附图|草图|绘图/.test(text);
}

function unresolvedP0(blockers: PatentBlocker[]) {
  return blockers.filter((blocker) => blocker.severity === 'P0' && !blocker.resolved);
}

function cleanClaims(value: string) {
  return normalizeClaimsText(
    value
      .replace(/^```[\s\S]*?\n/, '')
      .replace(/\n```$/, '')
      .replace(/^#+\s*权利要求书\s*/i, '')
      .trim()
  );
}

async function loadDiagramSpecs(input: {
  projectId: string;
  relativeDir: string;
  disclosure: InventionDisclosure;
  strategy?: ClaimStrategy | null;
  signal?: AbortSignal;
  emit?: (event: PatentProgressEvent) => void | Promise<void>;
}): Promise<PatentDiagramSpec[]> {
  let specs: PatentDiagramSpec[] = [];
  try {
    const plan = await loadWorkspaceArtifactWithRetry({
      projectId: input.projectId,
      relativeDir: input.relativeDir,
      fileName: 'drawings-plan.json',
      schema: diagramPlanSchema,
      stage: 'drawings',
      required: false,
      signal: input.signal,
      emit: input.emit,
      onStep: (step) => input.emit?.({
        type: 'status',
        stage: 'drawings',
        detail: formatPatentAgentStepDetail('附图计划修复：', step),
        progress: 0
      })
    });
    specs = (plan?.diagrams || []).filter(
      (item) => Array.isArray(item.nodes) && item.nodes.length > 0
    );
  } catch {
    specs = [];
  }
  if (!specs.length && input.disclosure.figureSuggestions.length) {
    const suggestedCount = Math.min(3, Math.max(1, input.disclosure.figureSuggestions.length));
    specs = buildFallbackDiagramSpecs(input.disclosure, input.strategy).slice(0, suggestedCount);
  } else if (!specs.length) {
    specs = buildFallbackDiagramSpecs(input.disclosure, input.strategy).slice(0, 3);
  }
  return specs;
}

async function renderDiagramAssets(input: {
  projectDir: string;
  specs: PatentDiagramSpec[];
  sourceAssets: PatentDrawingAsset[];
  disclosure: InventionDisclosure;
  strategy?: ClaimStrategy | null;
}) {
  const budget = Math.max(0, 6 - input.sourceAssets.length);
  let generated: PatentDrawingAsset[] = [];
  try {
    if (input.specs.length) {
      generated = await persistGeneratedDiagrams({
        projectDir: input.projectDir,
        specs: input.specs.slice(0, budget),
        startFigureNumber: input.sourceAssets.length + 1
      });
    }
  } catch {
    generated = [];
  }
  if (!generated.length && budget > 0) {
    const fallback = buildFallbackDiagramSpecs(input.disclosure, input.strategy).slice(
      0,
      Math.min(3, budget)
    );
    if (fallback.length) {
      generated = await persistGeneratedDiagrams({
        projectDir: input.projectDir,
        specs: fallback,
        startFigureNumber: input.sourceAssets.length + 1
      });
    }
  }
  return [...input.sourceAssets, ...generated];
}

function normalizeMathNotation(value: string) {
  const controlsFixed = value
    .replace(/\u000crac/g, '\\frac')
    .replace(/\t(au|heta)/g, '\\$1');
  return controlsFixed.replace(/(\${1,2})([\s\S]*?)\1/g, (_match, delimiter: string, expression: string) => {
    const normalized = expression
      .replace(/\b(sum|min|max)(?=[_{(])/g, '\\$1')
      .replace(/([A-Za-z}])in\s+([A-Za-z])/g, '$1\\in $2')
      .replace(/\s(le|ge|approx|cdot)\s/g, ' \\$1 ')
      .replace(
        /(?<![A-Za-z\\])(Delta|lambda|mu|alpha|delta|tau|theta|pi)(?![A-Za-z])/g,
        '\\$1'
      );
    return `${delimiter}${normalized}${delimiter}`;
  });
}

export function normalizePatentDraft(draft: PatentDraft): PatentDraft {
  const dedupeParagraphs = (value: string) => {
    const seen = new Set<string>();
    return value
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => {
        if (!paragraph) return false;
        const key = paragraph.replace(/\s+/g, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join('\n\n');
  };
  return {
    ...draft,
    title: draft.title.replace(/^发明名称[：:\s]*/i, '').trim(),
    abstract: draft.abstract.replace(/^说明书摘要[：:\s]*/i, '').trim(),
    claims: cleanClaims(normalizeMathNotation(draft.claims)),
    technicalField: draft.technicalField.replace(/^技术领域[：:\s]*/i, '').trim(),
    backgroundArt: draft.backgroundArt.replace(/^背景技术[：:\s]*/i, '').trim(),
    inventionSummary: draft.inventionSummary.replace(/^发明内容[：:\s]*/i, '').trim(),
    drawingDescription: draft.drawingDescription.replace(/^附图说明[：:\s]*/i, '').trim(),
    embodiments: dedupeParagraphs(
      normalizeMathNotation(draft.embodiments).replace(/^具体实施方式[：:\s]*/i, '').trim()
    )
  };
}

async function emitProject(
  projectId: string,
  kind: string,
  emit?: (event: PatentProgressEvent) => void
) {
  const project = await requirePatentProject(projectId);
  emit?.({ type: 'artifact', kind, project });
  return project;
}

async function requirePatentProject(projectId: string) {
  const project = await getPatentProject(projectId);
  if (!project) throw new Error('专利项目不存在或已被删除。');
  return project;
}

function filterAutoBlockers(blockers: PatentBlocker[]) {
  return blockers.filter((blocker) => !canAutoResolvePatentQuestion(blocker.question, blocker.reason));
}

export async function runPatentPipeline(
  projectId: string,
  emit?: (event: PatentProgressEvent) => void,
  options: { signal?: AbortSignal } = {}
) {
  const throwIfAborted = () => {
    if (!options.signal?.aborted) return;
    throw new DOMException('专利生成已取消', 'AbortError');
  };
  const status = async (stage: PatentStage, detail: string, progress: number) => {
    throwIfAborted();
    await setPatentProgress(projectId, { status: 'processing', stage });
    emit?.({ type: 'status', stage, detail, progress });
  };

  try {
    throwIfAborted();
    let project = await requirePatentProject(projectId);
    if (!project.source) throw new Error('专利项目或源文件不存在。');
    await setPatentProgress(projectId, { status: 'processing', stage: 'source', error: null });

    await status('source', '正在准备能元专利工作区…', 8);

    // 仅过滤“公式/公知原理”类可自动处理项；身份与实质技术缺口仍需用户确认。
    const actionableBlockers = filterAutoBlockers(project.blockers);
    if (actionableBlockers.length !== project.blockers.length) {
      await setPatentProgress(projectId, { blockers: actionableBlockers });
      project = await requirePatentProject(projectId);
    }
    const earlyBlocked = unresolvedP0(project.blockers);
    if (earlyBlocked.length) {
      await setPatentProgress(projectId, { status: 'needs_input', stage: 'questions' });
      const waiting = await requirePatentProject(projectId);
      emit?.({ type: 'done', project: waiting });
      return waiting;
    }

    let disclosure = project.disclosure;
    const relativeDir = 'opencode';
    preparePatentOpenCodeWorkspace({ project });
    const beforeClarification = readPatentWorkspaceStatus(projectId);
    const workspaceDisclosure = readPatentWorkspaceJson(projectId, 'disclosure.json');
    // 用户已答复并消解 P0 后，即使 STATUS 仍是 needs_input，也不要重跑交底；直接继续撰写。
    const openP0 = unresolvedP0(filterAutoBlockers(project.blockers));
    const needsClarification =
      !workspaceDisclosure
      || openP0.length > 0;

    if (needsClarification) {
      await status('disclosure', '正在分析技术交底并整理必要澄清问题…', 14);
      let clarificationProgress = 15;
      await runOpenCodePatentClarification({
        projectId,
        relativeDir,
        resume: Boolean(beforeClarification?.status || workspaceDisclosure),
        signal: options.signal,
        onStatus: (event) => emit?.({
          type: 'status',
          stage: 'clarification',
          detail: event.detail || event.phase,
          progress: Math.min(28, clarificationProgress)
        }),
        onStep: (step) => {
          clarificationProgress = Math.min(28, clarificationProgress + 1);
          emit?.({
            type: 'status',
            stage: 'clarification',
            detail: formatPatentAgentStepDetail('交底分析：', step),
            progress: clarificationProgress
          });
        }
      });
    }

    let workspaceStatus = recoverPatentWorkspaceStatus(projectId)
      || readPatentWorkspaceStatus(projectId);
    if (!workspaceStatus?.status) throw new Error('能元未写入 STATUS.json，交底分析未完成。');
    if (workspaceStatus.status === 'failed') {
      throw new Error(workspaceStatus.error || '能元交底分析失败。');
    }

    await status('disclosure', '正在入库交底分析结果…', 30);
    const disclosurePath = path.join(
      getPatentProjectDirectory(projectId),
      'opencode',
      'disclosure.json'
    );
    const hasDisclosureFile = Boolean(readPatentWorkspaceText(projectId, 'disclosure.json'))
      || fs.existsSync(disclosurePath);
    if (hasDisclosureFile) {
      disclosure = await loadWorkspaceArtifactWithRetry({
        projectId,
        relativeDir,
        fileName: 'disclosure.json',
        schema: disclosureSchema,
        stage: 'disclosure',
        signal: options.signal,
        emit,
        onStep: (step) => emit?.({
          type: 'status',
          stage: 'disclosure',
          detail: formatPatentAgentStepDetail('交底结构修复：', step),
          progress: 30
        })
      }) as InventionDisclosure;
      await savePatentArtifact(projectId, 'disclosure', disclosure);
      project = (await emitProject(projectId, 'disclosure', emit))!;
    }

    const hasClarificationFile = Boolean(readPatentWorkspaceText(projectId, 'clarification.json'));
    if (hasClarificationFile) {
      const clarification = await loadWorkspaceArtifactWithRetry({
        projectId,
        relativeDir,
        fileName: 'clarification.json',
        schema: clarificationSchema,
        stage: 'clarification',
        signal: options.signal,
        emit,
        onStep: (step) => emit?.({
          type: 'status',
          stage: 'clarification',
          detail: formatPatentAgentStepDetail('澄清结构修复：', step),
          progress: 30
        })
      });
      if (clarification) {
        const stillMissing = Array.isArray(clarification.stillMissing)
          ? clarification.stillMissing
          : [];
        await savePatentArtifact(projectId, 'clarification', {
          round: 1,
          supplementaryFacts: clarification.supplementaryFacts,
          stillMissing: stillMissing.filter(
            (item) => !canAutoResolvePatentQuestion(item.question, item.reason)
          ),
          readyForDrafting: clarification.readyForDrafting
        });
        project = (await emitProject(projectId, 'clarification', emit))!;
      }
    }

    const blockersRaw = readPatentWorkspaceJson(projectId, 'blockers.json');
    let blockers = mergeWorkspaceBlockers(project!, blockersRaw, disclosure);
    blockers = filterAutoBlockers(blockers);
    await setPatentProgress(projectId, { blockers });
    project = await requirePatentProject(projectId);

    if (workspaceStatus.status === 'needs_input' || unresolvedP0(blockers).length) {
      await setPatentProgress(projectId, {
        status: 'needs_input',
        stage: 'questions',
        blockers
      });
      const waiting = await requirePatentProject(projectId);
      emit?.({ type: 'done', project: waiting });
      return waiting;
    }

    if (!disclosure) {
      throw new Error('交底分析未生成可用的 disclosure.json（文件缺失或 JSON 损坏）。请重试生成。');
    }

    await status('prior_art', '正在基于定稿交底检索本地中国专利…', 34);
    let priorArt: PriorArtReport | undefined = project.priorArt;
    if (!priorArt) {
      priorArt = await searchPatentPriorArt(disclosure, (detail) =>
        emit?.({ type: 'status', stage: 'prior_art', detail, progress: 38 })
      );
      await savePatentArtifact(projectId, 'prior_art', priorArt);
      project = (await emitProject(projectId, 'prior_art', emit))!;
    }

    preparePatentOpenCodeWorkspace({ project, priorArt });
    const workspaceReady =
      readPatentWorkspaceStatus(projectId)?.status === 'ready'
      && Boolean(readPatentWorkspaceJson(projectId, 'strategy.json'))
      && Boolean(readPatentWorkspaceText(projectId, 'claims.txt'))
      && Boolean(readPatentWorkspaceJson(projectId, 'draft.json'));

    if (!workspaceReady) {
      await status('strategy', '正在制定保护策略并撰写申请文件…', 42);
      let stepProgress = 44;
      await runOpenCodePatentGeneration({
        projectId,
        relativeDir,
        resume: Boolean(readPatentWorkspaceJson(projectId, 'strategy.json')),
        signal: options.signal,
        onStatus: (event) => emit?.({
          type: 'status',
          stage: 'specification',
          detail: event.detail || event.phase,
          progress: Math.min(84, stepProgress)
        }),
        onStep: (step) => {
          stepProgress = Math.min(84, stepProgress + (step.type === 'tool_call' ? 2 : 1));
          emit?.({
            type: 'status',
            stage: 'specification',
            detail: formatPatentAgentStepDetail('撰写：', step),
            progress: stepProgress
          });
        }
      });
    } else {
      await status('specification', '已验证现有检查点，继续后续处理…', 84);
    }

    workspaceStatus = recoverPatentWorkspaceStatus(projectId)
      || readPatentWorkspaceStatus(projectId);
    if (!workspaceStatus?.status) throw new Error('能元未写入 STATUS.json，专利撰写未完成。');
    if (workspaceStatus.status === 'failed') {
      throw new Error(workspaceStatus.error || '能元专利生成失败。');
    }

    let strategy: ClaimStrategy | undefined = project.strategy;
    if (readPatentWorkspaceText(projectId, 'strategy.json') || readPatentWorkspaceJson(projectId, 'strategy.json')) {
      strategy = await loadWorkspaceArtifactWithRetry({
        projectId,
        relativeDir,
        fileName: 'strategy.json',
        schema: strategySchema,
        stage: 'strategy',
        signal: options.signal,
        emit,
        onStep: (step) => emit?.({
          type: 'status',
          stage: 'strategy',
          detail: formatPatentAgentStepDetail('策略结构修复：', step),
          progress: 42
        })
      }) as ClaimStrategy;
      await savePatentArtifact(projectId, 'strategy', strategy);
      project = (await emitProject(projectId, 'strategy', emit))!;
    }
    if (!strategy) throw new Error('缺少 strategy.json。');
    if (!disclosure) throw new Error('缺少 disclosure.json。');

    await status('drawings', '正在渲染说明书附图…', 90);
    let claimsText = cleanClaims(
      readPatentWorkspaceText(projectId, 'claims.txt')
      || readPatentWorkspaceJson<{ claims?: string }>(projectId, 'draft.json')?.claims
      || project.draft?.claims
      || ''
    );
    if (!claimsText) throw new Error('缺少 claims.txt。');

    const diagramSpecs = await loadDiagramSpecs({
      projectId,
      relativeDir,
      disclosure,
      strategy,
      signal: options.signal,
      emit
    });
    const projectDir = getPatentProjectDirectory(projectId);
    let sourceAssets: PatentDrawingAsset[] = [];
    const sourceRow = await getPatentSourceRow(projectId);
    const relevantSourceFigures = project.source?.extension === '.docx'
      ? project.source.parsed.figures.filter((figure) =>
          /流程|结构|框图|原理|示意|架构|连接/.test(figure.caption || '')
        ).slice(0, 3)
      : [];
    if (sourceRow && relevantSourceFigures.length) {
      sourceAssets = await extractSourceFigures({
        projectDir,
        sourcePath: sourceRow.storage_path,
        figures: relevantSourceFigures
      }).catch(() => []);
    }
    let drawingAssets = await renderDiagramAssets({
      projectDir,
      specs: diagramSpecs,
      sourceAssets,
      disclosure,
      strategy
    });
    const drawingNotes = sourceAssets.length
      ? [`复用源交底中 ${sourceAssets.length} 幅相关结构图，并补充能元附图计划`]
      : drawingAssets.length
        ? ['由能元附图计划或交底建议渲染']
        : ['附图计划不可用且回退渲染未产出文件'];
    let drawingsBundle = {
      assets: drawingAssets,
      generatedFromSuggestions: true,
      notes: drawingNotes
    };
    await savePatentArtifact(projectId, 'drawings', drawingsBundle);
    project = (await emitProject(projectId, 'drawings', emit))!;

    await status('specification', '正在整理说明书与摘要…', 93);
    let draft = await loadWorkspaceArtifactWithRetry({
      projectId,
      relativeDir,
      fileName: 'draft.json',
      schema: draftSchema,
      stage: 'specification',
      signal: options.signal,
      emit,
      onStep: (step) => emit?.({
        type: 'status',
        stage: 'specification',
        detail: formatPatentAgentStepDetail('草稿结构修复：', step),
        progress: 93
      })
    }) as PatentDraft;
    // claims.txt 是权利要求的权威源；避免 draft.json 残留旧版本覆盖审校修订。
    draft.claims = claimsText;
    if (!draft.drawingDescription.trim() || draft.drawingDescription.trim() === '无') {
      draft.drawingDescription = drawingDescriptionFromAssets(drawingAssets);
    }
    if (drawingAssets.length && (!draft.abstractFigure || draft.abstractFigure === '无')) {
      draft.abstractFigure = '图1';
    } else if (!drawingAssets.length) {
      draft.abstractFigure = '无';
    }
    draft = normalizePatentDraft({ ...draft, drawings: drawingAssets });
    await savePatentArtifact(projectId, 'draft', draft, draft.claims);
    project = (await emitProject(projectId, 'draft', emit))!;

    await status('audit', '正在执行多轮专业审校…', 94);
    let deterministic = validatePatentDraft(draft, disclosure, drawingsBundle);
    type ModelAuditShape = {
      issues: AuditIssue[];
      supportMatrix: PatentAudit['supportMatrix'];
      remainingRisks: string[];
    };
    let model: ModelAuditShape = {
      issues: [],
      supportMatrix: [],
      remainingRisks: []
    };
    if (readPatentWorkspaceText(projectId, 'audit.json')) {
      const loaded = await loadWorkspaceArtifactWithRetry({
        projectId,
        relativeDir,
        fileName: 'audit.json',
        schema: modelAuditSchema,
        stage: 'audit',
        required: false,
        signal: options.signal,
        emit,
        onStep: (step) => emit?.({
          type: 'status',
          stage: 'audit',
          detail: formatPatentAgentStepDetail('审校结构修复：', step),
          progress: 94
        })
      });
      if (loaded) {
        model = {
          issues: loaded.issues as AuditIssue[],
          supportMatrix: loaded.supportMatrix as PatentAudit['supportMatrix'],
          remainingRisks: loaded.remainingRisks
        };
      }
    }
    let audit: PatentAudit = {
      ...mergeModelAudit(deterministic, {
        issues: model.issues,
        supportMatrix: model.supportMatrix,
        remainingRisks: model.remainingRisks
      }),
      rounds: 0
    };

    const reloadDraftAfterReview = async () => {
      claimsText = cleanClaims(
        readPatentWorkspaceText(projectId, 'claims.txt')
        || readPatentWorkspaceJson<{ claims?: string }>(projectId, 'draft.json')?.claims
        || claimsText
      );
      draft = await loadWorkspaceArtifactWithRetry({
        projectId,
        relativeDir,
        fileName: 'draft.json',
        schema: draftSchema,
        stage: 'audit',
        signal: options.signal,
        emit,
        onStep: (step) => emit?.({
          type: 'status',
          stage: 'audit',
          detail: formatPatentAgentStepDetail('草稿结构修复：', step),
          progress: 96
        })
      }) as PatentDraft;
      draft.claims = claimsText;
      if (!draft.drawingDescription.trim() || draft.drawingDescription.trim() === '无') {
        draft.drawingDescription = drawingDescriptionFromAssets(drawingAssets);
      }
      if (drawingAssets.length && (!draft.abstractFigure || draft.abstractFigure === '无')) {
        draft.abstractFigure = '图1';
      } else if (!drawingAssets.length) {
        draft.abstractFigure = '无';
      }
      draft = normalizePatentDraft({ ...draft, drawings: drawingAssets });
      await savePatentArtifact(projectId, 'draft', draft, draft.claims);
      deterministic = validatePatentDraft(draft, disclosure, drawingsBundle);
      if (readPatentWorkspaceText(projectId, 'audit.json')) {
        const loaded = await loadWorkspaceArtifactWithRetry({
          projectId,
          relativeDir,
          fileName: 'audit.json',
          schema: modelAuditSchema,
          stage: 'audit',
          required: false,
          signal: options.signal,
          emit
        });
        if (loaded) {
          model = {
            issues: loaded.issues as AuditIssue[],
            supportMatrix: loaded.supportMatrix as PatentAudit['supportMatrix'],
            remainingRisks: loaded.remainingRisks
          };
        }
      }
    };

    const auditHasError = () =>
      deterministic.deterministicIssues.some((item) => item.severity === 'error')
      || model.issues.some((item) => item.severity === 'error');

    const canSkipRemainingReviews = () =>
      !auditHasError() && audit.score >= PATENT_REVIEW_SKIP_SCORE;

    let successfulReviewRounds = 0;
    for (let round = 1; round <= PATENT_REVIEW_MIN_ROUNDS; round += 1) {
      if (round > 1 && canSkipRemainingReviews()) {
        await status(
          'audit',
          `质量分 ${audit.score} 已达标且无 error，跳过剩余审校轮次。`,
          94 + round
        );
        break;
      }

      const angle = PATENT_REVIEW_ANGLES[(round - 1) % PATENT_REVIEW_ANGLES.length];
      const progress = Math.min(99, 94 + round);
      await status(
        'audit',
        `第 ${round}/${PATENT_REVIEW_MIN_ROUNDS} 轮专业审校（${angle.label}）…`,
        progress
      );

      writePatentWorkspaceJson(projectId, 'QUALITY_REPORT.json', {
        round,
        totalRounds: PATENT_REVIEW_MIN_ROUNDS,
        skipScore: PATENT_REVIEW_SKIP_SCORE,
        angle: angle.id,
        angleLabel: angle.label,
        focus: angle.focus,
        passed: audit.passed,
        score: audit.score,
        errors: [
          ...audit.deterministicIssues.filter((item) => item.severity === 'error'),
          ...audit.modelIssues.filter((item) => item.severity === 'error')
        ],
        warnings: [
          ...audit.deterministicIssues.filter((item) => item.severity === 'warning'),
          ...audit.modelIssues.filter((item) => item.severity === 'warning')
        ].slice(0, 10),
        requirements: [
          '按本轮专业角度深度审查，禁止只做结构打勾',
          '权利要求数量与客体类型服从技术贡献和来源支持',
          '摘要 ≤300 汉字；实施例达到充分公开要求',
          '附图数量按技术方案需要确定，图元文字清楚简明',
          '对 error 与实质 warning 就地修订后再写 audit.json'
        ]
      });

      try {
        throwIfAborted();
        await runOpenCodePatentReviewRound({
          projectId,
          relativeDir,
          round,
          totalRounds: PATENT_REVIEW_MIN_ROUNDS,
          angleId: angle.id,
          angleLabel: angle.label,
          focus: angle.focus,
          signal: options.signal,
          onStatus: (event) => {
            emit?.({
              type: 'status',
              stage: 'audit',
              detail: event.detail || event.phase,
              progress
            });
          },
          onStep: (step) => {
            emit?.({
              type: 'status',
              stage: 'audit',
              detail: formatPatentAgentStepDetail(`审校第${round}轮：`, step),
              progress
            });
          }
        });
        await reloadDraftAfterReview();
        audit = {
          ...mergeModelAudit(deterministic, {
            issues: model.issues,
            supportMatrix: model.supportMatrix,
            remainingRisks: model.remainingRisks
          }),
          rounds: round
        };
        successfulReviewRounds += 1;
        writePatentWorkspaceJson(projectId, `audit-round-${round}.json`, {
          round,
          angle: angle.id,
          angleLabel: angle.label,
          score: audit.score,
          passed: audit.passed,
          issues: [...audit.deterministicIssues, ...audit.modelIssues],
          remainingRisks: audit.remainingRisks
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : '审校轮失败';
        audit = {
          ...audit,
          remainingRisks: [...(audit.remainingRisks || []), `第${round}轮审校未完成：${reason}`],
          rounds: round
        };
      }

      if (round >= PATENT_REVIEW_MIN_ROUNDS) break;
      if (canSkipRemainingReviews()) {
        await status(
          'audit',
          `第 ${round} 轮后质量分 ${audit.score} 已达标，结束审校。`,
          99
        );
        break;
      }
    }

    // 审校 Agent 可修订附图计划；仅当新计划可解析且非空时才重渲染。
    // 计划损坏/为空时绝不能用空规格覆盖已有附图。
    try {
      const reviewedSpecs = await loadDiagramSpecs({
        projectId,
        relativeDir,
        disclosure,
        strategy,
        signal: options.signal,
        emit
      });
      const planChanged = JSON.stringify(reviewedSpecs) !== JSON.stringify(diagramSpecs);
      const needsFigures = drawingAssets.length === 0 && reviewedSpecs.length > 0;
      if ((planChanged || needsFigures) && reviewedSpecs.length > 0) {
        const regenerated = await renderDiagramAssets({
          projectDir,
          specs: reviewedSpecs,
          sourceAssets,
          disclosure,
          strategy
        });
        if (regenerated.length || drawingAssets.length === 0) {
          drawingAssets = regenerated.length ? regenerated : drawingAssets;
          drawingsBundle = {
            assets: drawingAssets,
            generatedFromSuggestions: true,
            notes: planChanged
              ? ['按最终审校后的附图计划重新渲染']
              : ['附图缺失，已按计划/交底建议补渲']
          };
          await savePatentArtifact(projectId, 'drawings', drawingsBundle);
          draft.drawingDescription = drawingDescriptionFromAssets(drawingAssets);
          draft.abstractFigure = drawingAssets.length ? '图1' : '无';
          draft = normalizePatentDraft({ ...draft, drawings: drawingAssets });
          await savePatentArtifact(projectId, 'draft', draft, draft.claims);
          deterministic = validatePatentDraft(draft, disclosure, drawingsBundle);
          audit = {
            ...mergeModelAudit(deterministic, {
              issues: model.issues,
              supportMatrix: model.supportMatrix,
              remainingRisks: model.remainingRisks
            }),
            rounds: audit.rounds
          };
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : '附图计划无法解析或渲染';
      // 已有附图时只记 warning，避免审校后空计划把整单打成失败。
      if (!drawingAssets.length) {
        audit = {
          ...audit,
          passed: false,
          score: Math.min(audit.score, 70),
          modelIssues: [
            ...audit.modelIssues,
            {
              id: 'DRAWINGS-REVIEW-REFRESH-FAILED',
              severity: 'error',
              category: 'drawings',
              message: `审校后附图未能同步重建：${reason}`
            }
          ]
        };
      } else {
        audit = {
          ...audit,
          modelIssues: [
            ...audit.modelIssues,
            {
              id: 'DRAWINGS-REVIEW-REFRESH-KEPT',
              severity: 'info',
              category: 'drawings',
              message: `审校后附图计划不可用，已保留现有 ${drawingAssets.length} 幅附图：${reason}`
            }
          ]
        };
      }
    }

    if (successfulReviewRounds === 0) {
      audit = {
        ...audit,
        passed: false,
        score: Math.min(audit.score, 70),
        modelIssues: [
          ...audit.modelIssues,
          {
            id: 'AUDIT-NOT-COMPLETED',
            severity: 'error',
            category: 'audit',
            message: '模型专业审校未成功完成，草稿必须人工复核后再提交。'
          }
        ]
      };
    }
    await savePatentArtifact(projectId, 'audit', audit);
    project = (await emitProject(projectId, 'audit', emit))!;

    const score = audit.score;
    const remainingErrors = [
      ...audit.deterministicIssues.filter((item) => item.severity === 'error'),
      ...audit.modelIssues.filter((item) => item.severity === 'error')
    ];
    if (remainingErrors.length || !audit.passed) {
      const reviewReason = remainingErrors.length
        ? `仍有 ${remainingErrors.length} 项 error`
        : `质量分 ${score} 未达到通过门槛`;
      await setPatentProgress(projectId, {
        status: 'review_required',
        stage: 'ready',
        qualityScore: score,
        error: `经 ${audit.rounds} 轮审校${reviewReason}，请打开审校结果复核后再提交。`
      });
      const review = await requirePatentProject(projectId);
      emit?.({
        type: 'status',
        stage: 'ready',
        detail: `草稿已生成，经 ${audit.rounds} 轮审校${reviewReason}，请复核。`,
        progress: 100
      });
      emit?.({ type: 'done', project: review });
      return review;
    }

    await setPatentProgress(projectId, {
      status: 'completed',
      stage: 'ready',
      qualityScore: score,
      error: ''
    });
    const ready = await requirePatentProject(projectId);
    emit?.({
      type: 'status',
      stage: 'ready',
      detail: `专利草稿已生成，并通过 ${audit.rounds} 轮专业审校（分数 ${score}）。`,
      progress: 100
    });
    emit?.({ type: 'done', project: ready });
    return ready;
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      await setPatentProgress(projectId, {
        status: 'cancelled',
        error: '生成已取消，可从检查点重新开始。'
      });
      throw error;
    }
    const message = error instanceof z.ZodError
      ? `模型产物结构不完整：${error.issues
          .slice(0, 5)
          .map((item) => `${item.path.join('.') || '根节点'} ${item.message}`)
          .join('；')}`
      : error instanceof Error
        ? error.message
        : '专利生成失败。';
    await setPatentProgress(projectId, { status: 'failed', stage: 'failed', error: message });
    emit?.({ type: 'error', error: message, stage: 'failed' });
    const failed = await getPatentProject(projectId);
    if (failed) emit?.({ type: 'done', project: failed });
    throw error;
  }
}

/** @deprecated 保留供脚本兼容；现由 OpenCode patent-audit skill 负责模型审校。 */
export async function auditDraft(
  _disclosure: InventionDisclosure,
  project: PatentProject,
  draft: PatentDraft,
  _parsed: unknown
) {
  if (!project.disclosure) throw new Error('缺少交底。');
  const deterministic = validatePatentDraft(draft, project.disclosure, project.drawings);
  return {
    ...mergeModelAudit(deterministic, { issues: [], supportMatrix: [], remainingRisks: [] }),
    rounds: 1
  } satisfies PatentAudit;
}

// Re-export for callers that previously imported answers formatting via prompts.
export { formatPatentUserAnswers as formatUserAnswers };
