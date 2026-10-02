import { jsonrepair } from 'jsonrepair';
import { z } from 'zod';
import { GRID_GUIDE_AGENT, GRID_GUIDE_SMALL_THINKING } from '@/lib/grid-guide/constants';
import { runOpenCodeQuestion } from '@/lib/opencode/runtime';
import {
  cacheGridGuideAttachmentsForOpenCode,
  formatGridGuideAttachmentPromptBlock,
  listReadyGridGuideAttachmentRows
} from './attachments';
import {
  diffChangedPaths,
  getStringAtPath,
  locateSelectionTargets,
  normalizeMatchText,
  pathKey,
  replaceNormalized,
  setStringAtPath,
  walkStringFields,
  type DocumentPath,
  type StringField
} from './document-paths';
import {
  cleanGridGuideFormalText as cleanFormalText,
  sanitizeGridGuideFormalReferences
} from './sanitize';
import {
  emptyTechLandscape,
  formatCorpusHitsForPrompt,
  formatTechLandscapeChatSummary,
  searchCorpusExistingTech
} from './tech-landscape';
import type {
  GridGuideDocument,
  GridGuideProject,
  TechLandscape,
  TechLandscapeEntry
} from './types';

async function prepareAttachmentPrompt(projectId: string) {
  const rows = await listReadyGridGuideAttachmentRows(projectId);
  if (!rows.length) return { attachmentBlock: '', hasAttachments: false };
  const paths = cacheGridGuideAttachmentsForOpenCode(projectId, rows);
  return {
    attachmentBlock: formatGridGuideAttachmentPromptBlock(paths),
    hasAttachments: paths.length > 0
  };
}

export { locateSelectionTargets, diffChangedPaths, pathKey } from './document-paths';

const text = z.string().trim().min(1);
const topicSchema = z.object({
  title: text,
  researchContent: z.array(text).min(2),
  expectedGoal: text,
  assessmentIndicators: z.array(text).min(2)
});

const techLandscapeEntrySchema = z.object({
  title: text,
  gist: text,
  gapOrDifference: z.string().trim().optional(),
  sourceLabel: z.string().trim().optional(),
  url: z.string().trim().optional()
});

const techLandscapeSchema = z
  .object({
    overview: z.string().trim().default(''),
    existingInCorpus: z.array(techLandscapeEntrySchema).default([]),
    latestOnline: z.array(techLandscapeEntrySchema).default([]),
    differentiations: z
      .array(
        z.object({
          proposedInnovation: text,
          differenceFromExisting: text,
          differenceFromLatest: text
        })
      )
      .default([])
  })
  .default({
    overview: '',
    existingInCorpus: [],
    latestOnline: [],
    differentiations: []
  });

const documentSchema = z.object({
  projectTitle: text,
  guide: z.object({
    technicalCategory: text,
    overallObjective: text,
    topicSetup: z.array(text).min(2),
    implementationPeriod: text,
    topics: z.array(topicSchema).min(2).max(8),
    maturityAndApplication: text,
    budgetLimit: text
  }),
  explanation: z.object({
    technicalDemandAnalysis: text,
    currentStatusAndResearchWork: text,
    topicSetupExplanation: text,
    planningCorrespondence: z.object({
      guideName: text,
      requirementNumber: text,
      requirementName: text,
      technicalField: text,
      proposingUnit: text
    }),
    undertakingEntity: text
  }),
  evidenceSummary: z.array(text).default([]),
  techLandscape: techLandscapeSchema
});

const pathPartSchema = z.union([z.string(), z.number().int().nonnegative()]);
const documentEditSchema = z.object({
  edits: z.array(z.object({
    path: z.array(pathPartSchema).min(1).max(8),
    oldText: z.string().min(1).optional(),
    newText: z.string().min(1)
  })).min(1).max(20),
  summary: text
});

type DocumentEdit = z.infer<typeof documentEditSchema>['edits'][number];

function stripListMarker(value: string) {
  return value
    .replace(/^\s*(?:[（(]\s*\d+\s*[）)]|\d+\s*[.、．)])\s*/, '')
    .trim();
}

export function normalizeGridGuideDocument(document: GridGuideDocument): GridGuideDocument {
  const topics = document.guide.topics.map((topic) => ({
    title: cleanFormalText(topic.title.replace(/^\s*课题\s*\d+\s*[：:、.．]?\s*/, '')),
    researchContent: topic.researchContent.map((value) => cleanFormalText(stripListMarker(value))),
    expectedGoal: cleanFormalText(topic.expectedGoal),
    assessmentIndicators: topic.assessmentIndicators.map((value) => cleanFormalText(stripListMarker(value)))
  }));
  const projectTitle = cleanFormalText(document.projectTitle.replace(/^[《“"]|[》”"]$/g, ''));
  const landscape = document.techLandscape || emptyTechLandscape();
  return sanitizeGridGuideFormalReferences({
    ...document,
    projectTitle,
    guide: {
      ...document.guide,
      technicalCategory: cleanFormalText(document.guide.technicalCategory),
      overallObjective: cleanFormalText(document.guide.overallObjective),
      topicSetup: document.guide.topicSetup.map((value) =>
        cleanFormalText(value.replace(/^\s*课题\s*\d+\s*[：:、.．]?\s*/, ''))
      ),
      implementationPeriod: cleanFormalText(document.guide.implementationPeriod),
      topics,
      maturityAndApplication: cleanFormalText(document.guide.maturityAndApplication),
      budgetLimit: cleanFormalText(document.guide.budgetLimit)
    },
    explanation: {
      ...document.explanation,
      technicalDemandAnalysis: cleanFormalText(document.explanation.technicalDemandAnalysis),
      currentStatusAndResearchWork: cleanFormalText(document.explanation.currentStatusAndResearchWork),
      topicSetupExplanation: cleanFormalText(document.explanation.topicSetupExplanation),
      planningCorrespondence: {
        guideName: projectTitle,
        requirementNumber: cleanFormalText(document.explanation.planningCorrespondence.requirementNumber),
        requirementName: cleanFormalText(document.explanation.planningCorrespondence.requirementName),
        technicalField: cleanFormalText(document.explanation.planningCorrespondence.technicalField),
        proposingUnit: cleanFormalText(document.explanation.planningCorrespondence.proposingUnit)
      },
      undertakingEntity: cleanFormalText(document.explanation.undertakingEntity)
    },
    techLandscape: {
      overview: cleanFormalText(landscape.overview || ''),
      existingInCorpus: landscape.existingInCorpus || [],
      latestOnline: landscape.latestOnline || [],
      differentiations: landscape.differentiations || []
    }
  });
}

function mergeCorpusHitsIntoLandscape(
  landscape: TechLandscape | undefined,
  corpusHits: TechLandscapeEntry[]
): TechLandscape {
  const base = landscape || emptyTechLandscape();
  if (!corpusHits.length) return base;
  if (base.existingInCorpus.length >= 3) return base;
  const existingTitles = new Set(
    base.existingInCorpus.map((item) => item.title.replace(/[\s《》“”"'：:，,。.-]/g, '').toLowerCase())
  );
  const extras = corpusHits.filter((item) => {
    const key = item.title.replace(/[\s《》“”"'：:，,。.-]/g, '').toLowerCase();
    return key && !existingTitles.has(key);
  });
  return {
    ...base,
    existingInCorpus: [...base.existingInCorpus, ...extras].slice(0, 10)
  };
}

function buildGenerationSummary(document: GridGuideDocument, isRevision: boolean) {
  const landscape = document.techLandscape;
  const hasComparison =
    landscape &&
    (landscape.differentiations.length > 0 ||
      landscape.existingInCorpus.length > 0 ||
      landscape.latestOnline.length > 0 ||
      Boolean(landscape.overview.trim()));
  if (hasComparison) {
    const prefix = isRevision
      ? '已根据你的意见完成修订，并重新校准技术对标。\n\n'
      : '';
    return `${prefix}${formatTechLandscapeChatSummary(landscape)}`;
  }
  return isRevision
    ? '已根据你的意见完成修订，并同步更新指南与编制说明。'
    : '已完成库内与联网技术检索、创新方案设计，以及指南与编制说明撰写。';
}

function trimObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => trimObjectKeys(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key.trim(),
        trimObjectKeys(item)
      ])
    );
  }
  return value;
}

function asTextList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    const lines = value
      .split(/\n+/)
      .map((line) => line.replace(/^\s*(?:[（(]?\d+[）)]|[0-9]+[.、．)])\s*/, '').trim())
      .filter(Boolean);
    return lines.length ? lines : [value.trim()];
  }
  return undefined;
}

function asPlainText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map((item) => asPlainText(item) || '').filter(Boolean).join('；');
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => asPlainText(item) || '')
      .filter(Boolean)
      .join('；');
  }
  return String(value);
}

/** 容错模型常见跑偏：键名带空格、数组写成字符串/对象、预算写成对象等。 */
function coerceGuidePayload(value: unknown): unknown {
  const root = trimObjectKeys(value);
  if (!root || typeof root !== 'object' || Array.isArray(root)) return root;
  const doc = { ...(root as Record<string, unknown>) };

  if (doc.guide && typeof doc.guide === 'object' && !Array.isArray(doc.guide)) {
    const guide = { ...(doc.guide as Record<string, unknown>) };
    const topicSetup = asTextList(guide.topicSetup);
    if (topicSetup) guide.topicSetup = topicSetup;
    else if (guide.topicSetup && typeof guide.topicSetup === 'object') {
      const values = Object.values(guide.topicSetup as Record<string, unknown>)
        .map((item) => asPlainText(item) || '')
        .filter(Boolean);
      if (values.length) guide.topicSetup = values;
    }
    if (guide.budgetLimit != null && typeof guide.budgetLimit !== 'string') {
      guide.budgetLimit = asPlainText(guide.budgetLimit) || '待核定。';
    }
    if (Array.isArray(guide.topics)) {
      guide.topics = guide.topics.map((topic) => {
        if (!topic || typeof topic !== 'object' || Array.isArray(topic)) return topic;
        const item = { ...(topic as Record<string, unknown>) };
        const research = asTextList(item.researchContent);
        if (research) item.researchContent = research;
        const indicators = asTextList(item.assessmentIndicators);
        if (indicators) item.assessmentIndicators = indicators;
        if (item.expectedGoal != null && typeof item.expectedGoal !== 'string') {
          item.expectedGoal = asPlainText(item.expectedGoal) || '';
        }
        return item;
      });
    }
    doc.guide = guide;
  }

  if (doc.explanation && typeof doc.explanation === 'object' && !Array.isArray(doc.explanation)) {
    const explanation = { ...(doc.explanation as Record<string, unknown>) };
    for (const key of [
      'technicalDemandAnalysis',
      'currentStatusAndResearchWork',
      'topicSetupExplanation',
      'undertakingEntity'
    ]) {
      if (explanation[key] != null && typeof explanation[key] !== 'string') {
        explanation[key] = asPlainText(explanation[key]) || '';
      }
    }
    if (
      explanation.planningCorrespondence != null &&
      typeof explanation.planningCorrespondence !== 'object'
    ) {
      const textValue = asPlainText(explanation.planningCorrespondence) || '';
      explanation.planningCorrespondence = {
        guideName: asPlainText(doc.projectTitle) || '',
        requirementNumber: '建议新增（待赋号）',
        requirementName: textValue.slice(0, 80) || '待补充',
        technicalField: '待补充',
        proposingUnit: '建议由相关省级电力公司提出'
      };
    } else if (
      explanation.planningCorrespondence &&
      typeof explanation.planningCorrespondence === 'object'
    ) {
      const planning = { ...(explanation.planningCorrespondence as Record<string, unknown>) };
      for (const key of Object.keys(planning)) {
        if (planning[key] != null && typeof planning[key] !== 'string') {
          planning[key] = asPlainText(planning[key]) || '';
        }
      }
      explanation.planningCorrespondence = planning;
    }
    doc.explanation = explanation;
  }

  if (doc.evidenceSummary != null && !Array.isArray(doc.evidenceSummary)) {
    const list = asTextList(doc.evidenceSummary);
    doc.evidenceSummary = list || [asPlainText(doc.evidenceSummary) || '内部检索综合'].filter(Boolean);
  }

  if (doc.techLandscape && typeof doc.techLandscape === 'object' && !Array.isArray(doc.techLandscape)) {
    const landscape = { ...(doc.techLandscape as Record<string, unknown>) };
    for (const key of ['existingInCorpus', 'latestOnline'] as const) {
      if (!Array.isArray(landscape[key])) continue;
      landscape[key] = (landscape[key] as unknown[]).map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const item = { ...(entry as Record<string, unknown>) };
        if (typeof item.gist !== 'string') item.gist = asPlainText(item.gist) || asPlainText(item.summary) || '（要点待补）';
        if (typeof item.title !== 'string') item.title = asPlainText(item.title) || '未命名条目';
        if (item.url === '') delete item.url;
        return item;
      });
    }
    doc.techLandscape = landscape;
  }

  return doc;
}

function formatZodIssues(error: z.ZodError) {
  return error.issues
    .slice(0, 12)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('；');
}

export function parseGridGuideModelAnswer(answer: string): GridGuideDocument {
  return parseDocument(answer);
}

function parseDocument(answer: string): GridGuideDocument {
  const unfenced = answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unfenced.indexOf('{');
  if (start < 0) throw new Error('能元未返回 JSON 项目指南。');
  const lastBrace = unfenced.lastIndexOf('}');
  const raw = unfenced
    .slice(start, lastBrace > start ? lastBrace + 1 : undefined)
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const candidates = [raw];
  try {
    candidates.push(jsonrepair(raw));
  } catch {
    // The model-based repair below handles output that jsonrepair cannot recover.
  }
  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = coerceGuidePayload(JSON.parse(candidate));
      return normalizeGridGuideDocument(documentSchema.parse(parsed));
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof z.ZodError) {
    throw new Error(`项目指南字段校验失败：${formatZodIssues(lastError)}`);
  }
  throw lastError instanceof Error ? lastError : new Error('项目指南 JSON 校验失败。');
}

function parseDocumentEdits(answer: string) {
  const unfenced = answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unfenced.indexOf('{');
  if (start < 0) throw new Error('能元未返回局部修改指令。');
  const end = unfenced.lastIndexOf('}');
  const raw = unfenced
    .slice(start, end > start ? end + 1 : undefined)
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const candidates = [raw];
  try {
    candidates.push(jsonrepair(raw));
  } catch {
    // continue with raw candidate
  }
  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try {
      return documentEditSchema.parse(JSON.parse(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('局部修改结果格式异常，请再试一次。');
}

function syncLinkedTitleFields(document: GridGuideDocument, path: DocumentPath, value: string) {
  if (path.length === 1 && path[0] === 'projectTitle') {
    document.explanation.planningCorrespondence.guideName = value;
  }
  if (path[0] === 'guide' && path[1] === 'topicSetup' && typeof path[2] === 'number' && document.guide.topics[path[2]]) {
    document.guide.topics[path[2]]!.title = value;
  }
  if (
    path[0] === 'guide' &&
    path[1] === 'topics' &&
    typeof path[2] === 'number' &&
    path[3] === 'title' &&
    document.guide.topicSetup[path[2]] !== undefined
  ) {
    document.guide.topicSetup[path[2]] = value;
  }
}

function resolveEditPath(document: GridGuideDocument, edit: DocumentEdit, hintPaths: DocumentPath[]) {
  const hinted = hintPaths.length > 0;

  if (hinted) {
    const exactHint = hintPaths.find((hint) => pathKey(hint) === pathKey(edit.path));
    if (exactHint) return exactHint;
    // 模型常漏写数组下标，例如 ["guide","topics",3,"researchContent"]
    const underHint = hintPaths.filter((hint) => edit.path.every((part, index) => part === hint[index]));
    if (underHint.length === 1) return underHint[0]!;
    if (hintPaths.length === 1) return hintPaths[0]!;
    if (edit.oldText?.trim()) {
      const needle = normalizeMatchText(edit.oldText);
      const hit = hintPaths.find((hint) => {
        const value = getStringAtPath(document, hint);
        return value ? normalizeMatchText(value).includes(needle) : false;
      });
      if (hit) return hit;
    }
    return null;
  }

  if (getStringAtPath(document, edit.path) !== null) return edit.path;
  if (!edit.oldText?.trim()) return null;
  const needle = normalizeMatchText(edit.oldText);
  if (!needle) return null;
  const fields = walkStringFields(document);
  const hit = fields.find((field) => normalizeMatchText(field.value).includes(needle));
  return hit?.path || null;
}

function applyDocumentEdits(
  source: GridGuideDocument,
  edits: DocumentEdit[],
  options?: { hintPaths?: DocumentPath[]; selection?: string }
) {
  const document = structuredClone(source) as GridGuideDocument;
  const hintPaths =
    options?.hintPaths ||
    locateSelectionTargets(source, options?.selection).map((item) => item.path);

  if (options?.selection?.trim() && !hintPaths.length) {
    throw new Error('未能准确定位你划选的原文所在段落，请重新划选后再试。');
  }

  for (const edit of edits) {
    if (
      edit.path.some((part) =>
        typeof part === 'string' && ['__proto__', 'prototype', 'constructor'].includes(part)
      )
    ) {
      continue;
    }
    const path = resolveEditPath(document, edit, hintPaths);
    if (!path) continue;
    if (hintPaths.length && !hintPaths.some((hint) => pathKey(hint) === pathKey(path))) {
      continue;
    }
    const current = getStringAtPath(document, path);
    if (current === null) continue;

    const nextText = edit.newText.replace(/\u00A0/g, ' ').trim();
    if (!nextText) continue;

    let next = current;
    const oldText = edit.oldText?.trim();
    if (!oldText) {
      next = nextText;
    } else {
      const replaced = replaceNormalized(current, oldText, nextText);
      if (replaced === null) {
        if (hintPaths.some((hint) => pathKey(hint) === pathKey(path))) {
          next = nextText;
        } else {
          continue;
        }
      } else {
        next = replaced;
      }
    }

    if (next === current || !next.trim()) continue;
    if (!setStringAtPath(document, path, next)) continue;
    syncLinkedTitleFields(document, path, next);
  }

  if (
    hintPaths.length === 1 &&
    edits.length >= 1 &&
    diffChangedPaths(source, document).length === 0
  ) {
    const path = hintPaths[0]!;
    const next = edits[0]!.newText.replace(/\u00A0/g, ' ').trim();
    const current = getStringAtPath(document, path);
    if (next && current !== null && next !== current) {
      setStringAtPath(document, path, next);
      syncLinkedTitleFields(document, path, next);
    }
  }

  const normalized = normalizeGridGuideDocument(documentSchema.parse(document));
  const changedPaths = diffChangedPaths(source, normalized);
  if (!changedPaths.length) {
    throw new Error('模型未对目标段落产生实质修改，请换种说法或重新划选后再试。');
  }
  if (hintPaths.length) {
    const touchedHint = changedPaths.some((path) =>
      hintPaths.some((hint) => pathKey(hint) === pathKey(path))
    );
    if (!touchedHint) {
      throw new Error('修改未落到你划选的段落上，已拒绝保存，请重试。');
    }
  }
  return {
    document: normalized,
    changed: changedPaths.length,
    changedPaths
  };
}

function describeDocumentPath(path: DocumentPath) {
  const [root, second, third, fourth, fifth] = path;
  if (root === 'projectTitle') return '项目名称';
  if (root === 'guide') {
    if (second === 'technicalCategory') return '技术类别';
    if (second === 'overallObjective') return '总体目标';
    if (second === 'topicSetup' && typeof third === 'number') return `课题设置第${third + 1}项`;
    if (second === 'topicSetup') return '课题设置情况';
    if (second === 'implementationPeriod') return '项目实施期限';
    if (second === 'maturityAndApplication') return '技术成熟度及成果应用';
    if (second === 'budgetLimit') return '支持经费限额';
    if (second === 'topics' && typeof third === 'number') {
      const topicNo = third + 1;
      if (fourth === 'title') return `课题${topicNo}标题`;
      if (fourth === 'expectedGoal') return `课题${topicNo}预期目标`;
      if (fourth === 'researchContent' && typeof fifth === 'number') {
        return `课题${topicNo}主要研究内容第${fifth + 1}条`;
      }
      if (fourth === 'researchContent') return `课题${topicNo}主要研究内容`;
      if (fourth === 'assessmentIndicators' && typeof fifth === 'number') {
        return `课题${topicNo}考核指标第${fifth + 1}条`;
      }
      if (fourth === 'assessmentIndicators') return `课题${topicNo}考核指标`;
      return `课题${topicNo}`;
    }
    return '项目申报指南';
  }
  if (root === 'explanation') {
    if (second === 'technicalDemandAnalysis') return '技术需求分析';
    if (second === 'currentStatusAndResearchWork') return '技术现状分析及需要开展的研究工作';
    if (second === 'topicSetupExplanation') return '课题设置说明';
    if (second === 'undertakingEntity') return '承担主体及说明';
    if (second === 'planningCorrespondence') {
      const labels: Record<string, string> = {
        guideName: '指南名称',
        requirementNumber: '规划/需求编号',
        requirementName: '规划/需求名称',
        technicalField: '技术领域',
        proposingUnit: '提出单位'
      };
      if (typeof third === 'string' && labels[third]) return `规划对应表·${labels[third]}`;
      return '项目与规划/需求的对应性';
    }
    return '编制说明';
  }
  return '正文';
}

function polishEditSummary(raw: string, changedPaths: DocumentPath[]) {
  const labels = [...new Set(changedPaths.map((path) => describeDocumentPath(path)))];
  const fallback =
    labels.length === 1
      ? `好的，已按你的要求改好了「${labels[0]}」。`
      : labels.length > 1
        ? `好的，已按你的要求更新了${labels.map((item) => `「${item}」`).join('、')}。`
        : '好的，已按你的要求改好了。';

  let summary = String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b(?:guide|explanation)\.[A-Za-z0-9_.\[\]]+/g, ' ')
    .replace(/\b(?:overallObjective|technicalCategory|topicSetupExplanation|researchContent|assessmentIndicators|expectedGoal|implementationPeriod|maturityAndApplication|budgetLimit|topicSetup|projectTitle|planningCorrespondence)\b/g, ' ')
    .replace(/\[\s*"(?:guide|explanation|projectTitle)"[^\]]*\]/g, ' ')
    .replace(/已完成\s*\d+\s*处局部修改[：:：]?\s*/g, '')
    .replace(/[（(][^（）()]*划选[^（）()]*[）)]/g, ' ')
    .replace(/[（(]\s*\d+\s*[）)]/g, ' ')
    .replace(/[A-Za-z]{3,}(?:\.[A-Za-z0-9_]+)+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[，,]{2,}/g, '，')
    .replace(/\s+([，。；：])/g, '$1')
    .replace(/^[，。；：\s]+|[，。；：\s]+$/g, '')
    .trim();

  // 清理后若过短、仍含英文路径痕迹、或句子残缺，则改用中文位置说明。
  const looksBroken =
    !summary ||
    summary.length < 8 ||
    /[A-Za-z]{4,}/.test(summary) ||
    /中关于|里的中|了\s*中|「\s*」/.test(summary) ||
    /（\s*）|\(\s*\)/.test(summary);

  if (looksBroken) return fallback;

  if (!/[。！？]$/.test(summary)) summary = `${summary}。`;
  if (!/^(好的|已|我|按|根据|这次|本轮)/.test(summary)) {
    summary = `好的，${summary}`;
  }
  return summary;
}

function buildQuickEditPrompt(input: {
  project: GridGuideProject;
  instruction: string;
  selection?: string;
  targets: StringField[];
  attachmentBlock?: string;
}) {
  const targetBlock = input.targets.length
    ? input.targets
        .map(
          (target, index) =>
            `${index + 1}. 中文位置：${describeDocumentPath(target.path)}\npath=${JSON.stringify(target.path)}\n原文：${target.value}`
        )
        .join('\n\n')
    : '未能预定位字段，请自行从完整文档 JSON 中定位。';
  const attachmentSection = input.attachmentBlock?.trim()
    ? `\n${input.attachmentBlock.trim()}\n如需核对创建时参考材料约束，可 read 上述路径；不要把路径写入 newText。\n`
    : '';

  return `你是文档局部编辑器，不要检索数据库，不要重新撰写整篇文档，只执行用户要求的最小范围文字修改。

用户要求：${input.instruction}
${input.selection?.trim() ? `用户明确划选的文字：${input.selection.trim()}` : '用户没有划选文字。'}
${attachmentSection}
已预定位的目标字段（必须且只能修改这些 path，禁止改其他字段）：
${targetBlock}

规则：
1. path 必须原样使用上面给出的预定位 path，不要改写成别的章节。
2. 推荐使用整字段替换：省略 oldText，只给 path + newText（newText 必须是该字段改完后的完整内容）。扩写、改写整段时必须用这种方式。
3. 若只改字段内一小段，可提供 oldText（必须能在该字段原文中匹配）和 newText。
4. 用户划选覆盖多个列表项时，为每个 path 各返回一条 edit。
5. 不要修改用户未要求的内容，不要重新设计课题，不要补充数据库证据。
6. newText 不得加入引用标记、文献编号、文件名、文件路径或“根据某文献”等溯源措辞。
7. summary 用自然、简洁的中文向用户说明改了什么，像同事回复一样口语清楚；禁止出现英文字段名、JSON path、guide.xxx、overallObjective 等技术标识；也不要用“已完成 N 处局部修改”这种套话。
8. 只输出 JSON，不要 Markdown 或解释：
{"edits":[{"path":["explanation","topicSetupExplanation"],"newText":"改后的完整条文"}],"summary":"已把课题设置说明里你选中的那段写得更完整了。"}

当前完整文档：
${JSON.stringify(input.project.document)}`;
}

function buildRepairPrompt(answer: string, project: GridGuideProject, validationError?: string) {
  const fallback = project.document
    ? `\n可参考的上一版合法文档：\n${JSON.stringify(project.document)}`
    : '';
  const errorBlock = validationError?.trim()
    ? `\n已知校验错误（请针对性修复，不要只回一句错误说明）：\n${validationError.trim()}\n`
    : '';
  return `你是 JSON / 结构修复器。下面是另一个模型生成的国家电网项目指南，可能存在：JSON 语法错误、键名带空格（如 " gist"）、字段类型不符（数组写成对象/字符串）、缺字段或截断。
${errorBlock}
要求：
1. 只输出一个完整合法 JSON 对象，不要 Markdown、不要解释、不要输出“JSON is not valid”这类句子。
2. 保留并补齐 projectTitle、guide、explanation、evidenceSummary、techLandscape 五个顶层字段。
3. guide 必须含 technicalCategory、overallObjective、topicSetup(字符串数组)、implementationPeriod、topics、maturityAndApplication、budgetLimit(字符串)；
4. 每个 topics 项必须含 title、researchContent(字符串数组)、expectedGoal、assessmentIndicators(字符串数组)；
5. explanation 必须含 technicalDemandAnalysis、currentStatusAndResearchWork、topicSetupExplanation、planningCorrespondence(对象)、undertakingEntity(字符串)；
6. techLandscape 必须含 overview、existingInCorpus、latestOnline、differentiations；其中条目字段名必须是 title/gist/gapOrDifference/sourceLabel/url，不得写成 " gist"。
7. 不要缩写已有正文；缺字段时按上下文补全为合理中文。
项目原始构想：${project.idea}${fallback}

待修复输出：
<broken_output>
${answer.slice(0, 80_000)}
</broken_output>`;
}

function formatCurrentDocument(document?: GridGuideDocument) {
  if (!document) return '当前尚无指南草稿，这是首次生成。';
  return `当前完整草稿如下，请在保留未被要求改动内容的前提下修订：\n${JSON.stringify(document, null, 2)}`;
}

function buildPrompt(input: {
  project: GridGuideProject;
  instruction: string;
  selection?: string;
  corpusHitsText: string;
  attachmentBlock?: string;
}) {
  const selection = input.selection?.trim()
    ? `\n用户在画布中选中的原文：\n<selection>\n${input.selection.trim()}\n</selection>\n`
    : '';
  const attachmentSection = input.attachmentBlock?.trim()
    ? `\n${input.attachmentBlock.trim()}\n`
    : '';
  return `你是国家电网总部科技项目指南首席策划专家。请同时检索：①知识库/语料中的已有技术；②网络上现有技术与最新方向；然后设计具有明确原创性、工程价值和可考核性的全新项目指南，并在 techLandscape 中完整写清「拟议新内容」相对两者的区别。

用户的项目构想：
${input.project.idea}
${attachmentSection}
本轮要求：
${input.instruction}
${selection}
${formatCurrentDocument(input.project.document)}

系统已完成的库内预检索结果（请吸收、可补充，不得虚构未出现的库内条目）：
${input.corpusHitsText}

必须严格采用国家电网总部科技项目指南的结构。参考项目的格式规律如下，但不得照抄其技术内容：

第一部分“项目申报指南”：
一、技术类别（基础研究类或应用研究类）
二、总体目标（需求背景、现有不足、拟解决问题、总体技术路线、预期应用成效）
三、课题设置情况（编号列出全部课题）
四、项目实施期限
五、课题内容（每个课题均包含：主要研究内容、预期目标、考核指标；研究内容和指标用编号条目）
六、技术成熟度及成果应用（说明当前成熟度等级、预期等级和应用推广路径）
七、支持经费限额

第二部分“项目申报指南编制说明”：
一、技术需求分析
二、技术现状分析及需要开展的研究工作
三、课题设置说明（解释课题间依赖关系与完整技术链条）
四、项目与规划/需求的对应性（指南名称、规划/需求编号、规划/需求名称、技术领域、提出单位）
五、承担主体及说明

检索与对标要求（必须执行）：
A. 库内检索：结合上方预检索结果，必要时再用 grep/read/glob 补充论文、专利、科研项目语料，识别已有技术能力、共性方案与空白。
B. 联网检索：必须使用 websearch（可配合 webfetch）检索该方向的现有公开技术与 2024—2026 年最新进展、标准/示范/产业动态；禁止编造网址与文献。若联网失败，在 latestOnline 写明限制并仍基于可核验信息作差异判断。
C. 差异综合：在 techLandscape 中完整写出：本指南提出的新东西、库内已有相关技术、网络最新技术方向，以及每一项拟议创新相对「已有」和「最新」的具体区别（不能只写“更具创新性”这类空话）。
D. 工具预算：检索类工具调用总计不超过 16 次；获得足够证据后立即综合撰写。

质量要求：
1. 先完成库内+联网检索与对标，再设计指南，不得只改写用户原话。
2. 项目名称应符合“研究对象/场景 + 核心问题 + 关键技术研究（及应用/示范）”的国网风格，避免空泛和堆砌概念。
3. 设置 3—5 个逻辑递进课题，覆盖机理/方法、关键技术、装备或软件、试验验证与示范应用；基础研究类可不强制装备。
4. 每个课题至少 3 条主要研究内容，考核指标必须量化并包含技术指标，以及合理的专利、论文、软著、报告或标准成果。
5. 不得虚构已存在的规划编号。无可靠依据时，requirementNumber 写“建议新增（待赋号）”，提出单位写合理的建议单位并明确“建议”。
6. 技术现状要按技术方向综合分析国内外方法、共性进展、瓶颈和必须开展的工作，直接陈述已经吸收的技术结论。严禁逐篇罗列文献，严禁使用“文献[编号]针对/提出”“某导师/专家研究了”等资料综述写法。
7. evidenceSummary 仅写 3—8 条内部设计依据的概括，不得包含文献编号、记录 ID、文件名、文件路径、作者或导师姓名；该字段不会进入正式正文。
8. techLandscape 供设计对话完整展示，必须充实：overview 一段总述；existingInCorpus 至少 3 条（若库内确无相关则写明并少列）；latestOnline 至少 3 条（含可核对的公开信息要点，url 能给则给）；differentiations 至少 3 条，每条含 proposedInnovation、differenceFromExisting、differenceFromLatest。gapOrDifference 写清该条目与本指南的差异。
9. 正文使用正式、严谨、完整的中文长段落，课题之间边界清楚且无重复。
10. 当前时间为 2026 年 7 月。项目起始时间不得早于 2027 年 1 月，实施期限通常为 3 年。
11. topicSetup 和 topics.title 只写课题名称，不要包含“课题1：”等编号；researchContent 和 assessmentIndicators 的数组项不要自带序号。
12. 检索材料只能作为内部设计依据。projectTitle、guide、explanation 的任何字段都不得出现网址、URL、http/https、Markdown 链接、方括号引用（如 [https://...]、[http）、“引用、来源、参见、引自、根据某文献/文件/论文”、文献编号、记录 ID、导师 ID、知识语料标签、mentor/paper 档案、文件名、文件路径或引用标记；应直接吸收其技术内容，以样例指南的正式口吻陈述。techLandscape 的 overview/标题/要点正文同样禁止夹带 [http 或裸 URL；仅 latestOnline.url 字段可写完整网址。

只输出一个 JSON 对象，不要 Markdown 代码围栏，不要解释。必须完全符合以下结构：
{
  "projectTitle": "项目名称（不含书名号）",
  "guide": {
    "technicalCategory": "应用研究类。",
    "overallObjective": "完整段落",
    "topicSetup": ["课题名称"],
    "implementationPeriod": "本项目研究的起止时间为……。",
    "topics": [{
      "title": "课题名称",
      "researchContent": ["研究内容1", "研究内容2", "研究内容3"],
      "expectedGoal": "完整段落",
      "assessmentIndicators": ["量化指标1", "成果指标2"]
    }],
    "maturityAndApplication": "完整段落",
    "budgetLimit": "数字万元。"
  },
  "explanation": {
    "technicalDemandAnalysis": "完整多段内容",
    "currentStatusAndResearchWork": "完整多段内容",
    "topicSetupExplanation": "完整多段内容",
    "planningCorrespondence": {
      "guideName": "与 projectTitle 相同",
      "requirementNumber": "编号或建议新增（待赋号）",
      "requirementName": "对应需求名称",
      "technicalField": "技术领域",
      "proposingUnit": "提出单位"
    },
    "undertakingEntity": "完整段落"
  },
  "evidenceSummary": ["检索启发"],
  "techLandscape": {
    "overview": "一段话概括拟议新内容相对库内已有与最新方向的总体差异",
    "existingInCorpus": [{
      "title": "库内相关技术/成果名称",
      "gist": "已有能力或方案要点",
      "gapOrDifference": "与本指南拟议内容的区别",
      "sourceLabel": "库内论文/专利/项目"
    }],
    "latestOnline": [{
      "title": "最新公开技术或方向名称",
      "gist": "最新进展要点",
      "gapOrDifference": "与本指南拟议内容的区别",
      "sourceLabel": "公开网页/标准/产业动态",
      "url": "https://可选"
    }],
    "differentiations": [{
      "proposedInnovation": "本指南提出的具体新内容",
      "differenceFromExisting": "相对库内已有技术的区别",
      "differenceFromLatest": "相对网络最新技术方向的区别"
    }]
  }
}`;
}

export async function generateGridGuide(input: {
  project: GridGuideProject;
  instruction: string;
  selection?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, detail: string) => void;
}) {
  let observedSteps = 0;
  let receivedText = false;
  input.onProgress?.(3, '正在准备参考附件');
  const { attachmentBlock } = await prepareAttachmentPrompt(input.project.id);
  input.onProgress?.(4, '正在检索库内已有技术');
  const corpusHits = await searchCorpusExistingTech(input.project.idea, (detail) => {
    input.onProgress?.(8, detail);
  });
  input.onProgress?.(10, '正在连接能元并准备联网检索最新技术');
  const result = await runOpenCodeQuestion(
    buildPrompt({
      ...input,
      corpusHitsText: formatCorpusHitsForPrompt(corpusHits),
      attachmentBlock
    }),
    {
      conversationId: `grid-guide:${input.project.id}`,
      sessionTitle: '国网指南设计',
      agent: GRID_GUIDE_AGENT,
      rawPrompt: true,
      modelRole: 'small',
      smallThinking: GRID_GUIDE_SMALL_THINKING,
      signal: input.signal,
      timeoutMs: 30 * 60 * 1000,
      onStatus: ({ detail }) => input.onProgress?.(12, detail || '正在分析项目构想'),
      onStep: (step) => {
        observedSteps += 1;
        const progress =
          step.type === 'synthesis'
            ? 72
            : Math.min(68, 16 + observedSteps * (step.type === 'tool_call' ? 4 : 3));
        const tool = String(step.tool || '').toLowerCase();
        const detail =
          step.type === 'tool_call'
            ? tool.includes('web')
              ? `正在检索网络最新技术${step.tool ? ` · ${step.tool}` : ''}`
              : `正在检索和分析库内技术${step.tool ? ` · ${step.tool}` : ''}`
            : step.type === 'synthesis'
              ? '检索完成，正在综合对标并撰写'
              : '正在分析检索结果与技术差异';
        input.onProgress?.(progress, detail);
      },
      onTextDelta: () => {
        if (receivedText) return;
        receivedText = true;
        input.onProgress?.(75, '正在撰写指南、编制说明与技术对标');
      },
      tools: {
        read: true,
        list: true,
        glob: true,
        grep: true,
        bash: true,
        webfetch: true,
        websearch: true
      }
    }
  );
  input.onProgress?.(82, '正在校验生成内容与结构');
  let document: GridGuideDocument;
  try {
    document = parseDocument(result.answer);
  } catch (firstError) {
    const validationError = firstError instanceof Error ? firstError.message : String(firstError);
    input.onProgress?.(86, '输出格式异常，正在自动修复（无需重新提交）');
    const repaired = await runOpenCodeQuestion(
      buildRepairPrompt(result.answer, input.project, validationError),
      {
        conversationId: `grid-guide-repair:${input.project.id}`,
        sessionTitle: '国网指南格式修复',
        agent: GRID_GUIDE_AGENT,
        rawPrompt: true,
        modelRole: 'small',
        smallThinking: GRID_GUIDE_SMALL_THINKING,
        signal: input.signal,
        timeoutMs: 10 * 60 * 1000,
        onTextDelta: () => input.onProgress?.(93, '格式已修复，正在进行最终校验'),
        tools: {
          read: false,
          list: false,
          glob: false,
          grep: false,
          bash: false,
          webfetch: false,
          websearch: false
        }
      }
    );
    try {
      document = parseDocument(repaired.answer);
    } catch (secondError) {
      const detail = secondError instanceof Error ? secondError.message : validationError;
      throw new Error(`模型输出格式异常，系统已尝试自动修复但仍未通过校验（${detail}），请重试本轮生成。`);
    }
  }
  document = {
    ...document,
    techLandscape: mergeCorpusHitsIntoLandscape(document.techLandscape, corpusHits)
  };
  document = normalizeGridGuideDocument(document);
  input.onProgress?.(97, '校验通过，正在保存到数据库');
  return {
    document,
    summary: buildGenerationSummary(document, Boolean(input.project.document))
  };
}

export async function reviseGridGuideQuick(input: {
  project: GridGuideProject;
  instruction: string;
  selection?: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, detail: string) => void;
}): Promise<{
  document: GridGuideDocument;
  summary: string;
  changedPaths: DocumentPath[];
}> {
  if (!input.project.document) throw new Error('指南尚未生成，无法执行局部修改。');
  const targets = locateSelectionTargets(input.project.document, input.selection);
  if (input.selection?.trim() && !targets.length) {
    throw new Error('未能准确定位你划选的原文所在段落，请重新划选后再试。');
  }
  input.onProgress?.(8, '正在准备参考附件');
  const { attachmentBlock, hasAttachments } = await prepareAttachmentPrompt(input.project.id);
  input.onProgress?.(12, targets.length ? '已定位目标段落，正在生成修改' : '正在定位需要修改的文字');
  let receivedText = false;
  const prompt = buildQuickEditPrompt({
    project: input.project,
    instruction: input.instruction,
    selection: input.selection,
    targets,
    attachmentBlock
  });
  const result = await runOpenCodeQuestion(prompt, {
    conversationId: `grid-guide-edit:${input.project.id}`,
    sessionTitle: '国网指南局部修改',
    agent: GRID_GUIDE_AGENT,
    rawPrompt: true,
    skipCorpusCheck: true,
    modelRole: 'small',
    smallThinking: GRID_GUIDE_SMALL_THINKING,
    signal: input.signal,
    timeoutMs: 5 * 60 * 1000,
    onStatus: () => input.onProgress?.(30, '正在理解修改要求'),
    onTextDelta: () => {
      if (receivedText) return;
      receivedText = true;
      input.onProgress?.(72, '正在生成局部文字补丁');
    },
    tools: {
      read: hasAttachments,
      list: false,
      glob: false,
      grep: false,
      bash: false
    }
  });
  input.onProgress?.(88, '正在核对并应用修改');
  const applyOptions = {
    hintPaths: targets.map((item) => item.path),
    selection: input.selection
  };
  let response: z.infer<typeof documentEditSchema>;
  let applied: ReturnType<typeof applyDocumentEdits>;
  try {
    response = parseDocumentEdits(result.answer);
    applied = applyDocumentEdits(input.project.document, response.edits, applyOptions);
  } catch (firstError) {
    input.onProgress?.(91, '局部补丁未能匹配，正在自动纠正');
    const corrected = await runOpenCodeQuestion(
      `${prompt}

上一次输出无法应用，原因：${firstError instanceof Error ? firstError.message : '格式或原文不匹配'}。
请改为整字段替换：每条 edit 只给 path 与 newText（不要 oldText），newText 必须是目标字段改完后的完整正文。
summary 仍须用自然中文，不要写英文字段名。
优先使用这些 path：${JSON.stringify(targets.map((item) => item.path))}
上一次输出如下：
${result.answer.slice(0, 10_000)}`,
      {
        conversationId: `grid-guide-edit:${input.project.id}`,
        sessionTitle: '国网指南局部修改',
        agent: GRID_GUIDE_AGENT,
        rawPrompt: true,
        skipCorpusCheck: true,
        modelRole: 'small',
        smallThinking: GRID_GUIDE_SMALL_THINKING,
        signal: input.signal,
        timeoutMs: 5 * 60 * 1000,
        tools: {
          read: hasAttachments,
          list: false,
          glob: false,
          grep: false,
          bash: false
        }
      }
    );
    response = parseDocumentEdits(corrected.answer);
    applied = applyDocumentEdits(input.project.document, response.edits, applyOptions);
  }
  input.onProgress?.(97, '修改已生效，正在保存');
  return {
    document: applied.document,
    summary: polishEditSummary(response.summary, applied.changedPaths),
    changedPaths: applied.changedPaths
  };
}
