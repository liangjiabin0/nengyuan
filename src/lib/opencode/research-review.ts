import type { ChatAttachment, ChatAttachmentRow } from '../chat-attachments';
import type { DisplaySource } from '../source-files';
import {
  RESEARCH_REVIEW_AGENT,
  RESEARCH_REVIEW_SESSION_MAP,
  RESEARCH_REVIEW_SKILL_NAME
} from '../research-review/constants';
import { MARKITDOWN_SKILL, ensureBundledSkills } from '../bundled-skills';
import { shouldOfferDocumentReader } from '../attachments/document-reader';
import { prepareResearchReviewMarkdown } from '../research-review/export';
import { buildSharedSkillPrompt, loadSharedSkillsForPrompt } from '../shared-skills';
import { prepareResearchReviewWorkspace } from './research-review-workspace';
import { runOpenCodeQuestion } from './runtime';
import type { ModelContextUsage, OpenCodeTraceMetrics, RuntimeAgentStep } from './types';

export type OpenCodeResearchReviewStatus = {
  phase: string;
  detail: string;
};

export type OpenCodeResearchReviewOptions = {
  conversationContext?: string;
  conversationId?: string;
  currentAttachments?: ChatAttachment[];
  currentAttachmentRows?: ChatAttachmentRow[];
  /** default：小模型关思考；high：小模型 xhigh / 大模型高能量提示 */
  reasoningEffort?: 'default' | 'high';
  modelRole?: 'small' | 'large';
  onStatus?: (status: OpenCodeResearchReviewStatus) => void;
  onAgentStep?: (step: RuntimeAgentStep) => void | Promise<void>;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onAnswerReset?: () => void | Promise<void>;
  onAnswerReplace?: (content: string) => void | Promise<void>;
  onContextUsage?: (usage: ModelContextUsage) => void | Promise<void>;
  signal?: AbortSignal;
};

export type OpenCodeResearchReviewAnswer = {
  answer: string;
  sources: DisplaySource[];
  graphSeedIds: string[];
  confidence?: 'high' | 'medium' | 'low';
  intent?: string;
  agentSteps: RuntimeAgentStep[];
  metrics: OpenCodeTraceMetrics;
};

const RESEARCH_REVIEW_TOOL_POLICY = {
  read: true,
  list: true,
  glob: true,
  grep: true,
  bash: true,
  edit: false,
  write: false,
  skill: true,
  task: false,
  webfetch: false,
  websearch: false,
  todowrite: false,
  lsp: false
} as const;

function stripProcessPreamble(answer: string) {
  return prepareResearchReviewMarkdown(answer);
}

function buildResearchReviewPrompt(
  question: string,
  attachmentPaths: Array<{
    attachmentId: string;
    name: string;
    relativePath: string;
    originalRelativePath?: string;
  }>,
  conversationContext?: string,
  sharedSkillPrompt?: string
) {
  const literatureBlock = attachmentPaths.length
    ? [
        '当前工作目录=本会话隔离目录。',
        '附件按原样放入 literature/（含 .orig.*）。系统未解压 ZIP，也未把 PDF/Word 预转成 Markdown。',
        '请先 read INDEX.md，再根据任务自行决定：解压压缩包、用文档读取技能转换、或直接 read 纯文本。',
        ...attachmentPaths.slice(0, 8).map(
          (item, index) => `${index + 1}. ${item.name} → ${item.originalRelativePath || item.relativePath}`
        ),
        attachmentPaths.length > 8
          ? `……其余 ${attachmentPaths.length - 8} 篇见 INDEX.md（共 ${attachmentPaths.length} 篇）。`
          : '',
        'Skill 规范在 refs/（随 skill 同步）。禁止 knowledge-corpus/ 路径与过程话进入最终正文。'
      ]
        .filter(Boolean)
        .join('\n')
    : '本轮未挂载新文献；若完全没有文献，先说明缺少证据并请用户上传。';

  return [
    '你正在「科研传承助手」中，基于用户上传文献撰写研究报告。',
    `必须先用 skill 工具加载 \`${RESEARCH_REVIEW_SKILL_NAME}\`，并严格按该 skill 的 Mandatory Workflow、Output Contract、Citation Contract 与 refs/ 规范一次性写完成品。`,
    '不要另起炉灶；不要先写提纲再补；最终公开回答只能是报告成品，从标题或摘要起笔。',
    '系统会把成品转成 Word 放到对话右侧「附件查看」。不要写“点击对话里的附件下载”，也不要在文末粘贴下载链接或再次贴出整份附件。',
    literatureBlock,
    sharedSkillPrompt || '',
    conversationContext
      ? `最近对话上下文（仅理解修订意图）：\n${conversationContext}`
      : '',
    `用户请求：\n${question}`
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function runOpenCodeResearchReview(
  question: string,
  options: OpenCodeResearchReviewOptions = {}
): Promise<OpenCodeResearchReviewAnswer> {
  const conversationId = options.conversationId?.trim();
  if (!conversationId) throw new Error('科研传承助手需要 conversationId');

  const paperCount = (options.currentAttachmentRows || []).filter(
    (row) => row.parse_status === 'ready'
  ).length;
  options.onStatus?.({
    phase: 'workspace',
    detail: paperCount
      ? `正在准备文献工作区（${paperCount} 篇）…`
      : '正在准备文献工作区…'
  });

  const { workingDirectory, attachmentPaths } = prepareResearchReviewWorkspace(
    conversationId,
    options.currentAttachmentRows || [],
    (status) => options.onStatus?.(status)
  );
  ensureBundledSkills();
  const needsMarkitdown = shouldOfferDocumentReader(options.currentAttachmentRows || []);
  const loadedSkills = await loadSharedSkillsForPrompt([
    ...(needsMarkitdown ? [MARKITDOWN_SKILL] : [])
  ]);
  if (loadedSkills.length) {
    options.onStatus?.({
      phase: 'skill',
      detail: `正在加载 ${loadedSkills.length} 个共享技能…`
    });
  }
  options.onStatus?.({
    phase: 'opencode_start',
    detail: '正在启动科研传承助手并加载 skill…'
  });

  const prompt = buildResearchReviewPrompt(
    question,
    attachmentPaths,
    options.conversationContext,
    buildSharedSkillPrompt(loadedSkills)
  );

  const result = await runOpenCodeQuestion(prompt, {
    conversationId,
    conversationContext: options.conversationContext,
    currentAttachments: options.currentAttachments,
    attachmentPaths,
    agent: RESEARCH_REVIEW_AGENT,
    sessionTitle: 'research-review',
    sessionMapFile: RESEARCH_REVIEW_SESSION_MAP,
    workingDirectory,
    tools: { ...RESEARCH_REVIEW_TOOL_POLICY },
    rawPrompt: true,
    skipCorpusCheck: true,
    reasoningEffort: options.reasoningEffort === 'high' ? 'high' : 'default',
    modelRole: options.modelRole === 'large' ? 'large' : 'small',
    onStatus: options.onStatus,
    onStep: options.onAgentStep,
    onTextDelta: options.onTextDelta,
    onAnswerReset: options.onAnswerReset,
    onAnswerReplace: options.onAnswerReplace
      ? async (content) => {
          await options.onAnswerReplace?.(stripProcessPreamble(content));
        }
      : undefined,
    onContextUsage: options.onContextUsage,
    signal: options.signal
  });

  return {
    answer: stripProcessPreamble(result.answer),
    sources: result.sources,
    graphSeedIds: result.graphSeedIds,
    confidence: result.confidence,
    intent: result.intent,
    agentSteps: result.steps,
    metrics: result.metrics
  };
}
