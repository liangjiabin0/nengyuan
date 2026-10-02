import { shouldOfferDocumentReader } from '../attachments/document-reader';
import {
  CHART_DISCOVERY_SKILL,
  MARKITDOWN_SKILL,
  ensureBundledSkills
} from '../bundled-skills';
import {
  chatAttachmentImagePaths,
  type ChatAttachment,
  type ChatAttachmentRow
} from '../chat-attachments';
import { ensureChatWorkspace } from '../chat-generated-charts';
import type { DisplaySource } from '../source-files';
import { loadSharedSkillsForPrompt, listCatalogSkills } from '../shared-skills';
import { parseChatSmallThinking } from '../reasoning-tier';
import { normalizeChatModelId, type ChatModelId } from '../model-ids';
import { formatSubagentRouterHint } from '../subagent-router';
import { getSubagentRouterConfig, syncOpenCodeSubagentRouter } from '../subagent-router-store';
import { writeOpenCodeAttachments } from './attachments';
import { CHAT_TOOL_POLICY } from './chat-tools';
import { runOpenCodeQuestion } from './runtime';
import type { ModelContextUsage, OpenCodeTraceMetrics, RuntimeAgentStep } from './types';

export type OpenCodeChatStatus = {
  phase: string;
  detail: string;
};

export type OpenCodeChatOptions = {
  conversationContext?: string;
  conversationId?: string;
  currentAttachments?: ChatAttachment[];
  currentAttachmentRows?: ChatAttachmentRow[];
  sessionAttachments?: ChatAttachment[];
  /** default：小模型关思考；high：小模型 xhigh / 大模型高能量提示 */
  reasoningEffort?: 'default' | 'high';
  /** 智能对话三档：off / medium / xhigh；未传时默认 medium */
  smallThinking?: 'off' | 'low' | 'medium' | 'xhigh';
  thinkingId?: string;
  modelRole?: 'small' | 'large' | 'storm';
  chatModel?: ChatModelId;
  learningMemoryPrompt?: string;
  learningMemoryFingerprint?: string;
  learningMemoryCount?: number;
  /** 输入框选中「主动生成数据图」后才加载出图技能与出图指令。 */
  enableChartGeneration?: boolean;
  onStatus?: (status: OpenCodeChatStatus) => void;
  onAgentStep?: (step: RuntimeAgentStep) => void | Promise<void>;
  onTextDelta?: (delta: string) => void | Promise<void>;
  onAnswerReset?: () => void | Promise<void>;
  onAnswerReplace?: (content: string) => void | Promise<void>;
  onContextUsage?: (usage: ModelContextUsage) => void | Promise<void>;
  signal?: AbortSignal;
};

export type OpenCodeChatAnswer = {
  answer: string;
  sources: DisplaySource[];
  graphSeedIds: string[];
  confidence?: 'high' | 'medium' | 'low';
  intent?: string;
  agentSteps: RuntimeAgentStep[];
  metrics: OpenCodeTraceMetrics;
};

/** 智能对话单轮最长执行时间（5 小时）。须与 next.config.js experimental.proxyTimeout 对齐。 */
export const CHAT_AGENT_TIMEOUT_MS = 5 * 60 * 60 * 1000;

export async function runOpenCodeChat(
  question: string,
  options: OpenCodeChatOptions = {}
): Promise<OpenCodeChatAnswer> {
  const conversationId = options.conversationId?.trim();
  if (!conversationId) throw new Error('能元问答需要 conversationId');

  const attachmentPaths = writeOpenCodeAttachments(
    conversationId,
    options.currentAttachmentRows || []
  );
  ensureBundledSkills();
  const workingDirectory = ensureChatWorkspace(conversationId);
  const skillCatalog = (await listCatalogSkills()).filter(
    (skill) => skill.name !== CHART_DISCOVERY_SKILL
  );
  const needsMarkitdown = shouldOfferDocumentReader(options.currentAttachmentRows || []);
  const loadedSkillIds = [
    ...(options.enableChartGeneration ? [CHART_DISCOVERY_SKILL] : []),
    ...(needsMarkitdown ? [MARKITDOWN_SKILL] : [])
  ];
  const loadedSkills = await loadSharedSkillsForPrompt(loadedSkillIds);
  // 子代理路由跑在 OpenCode 插件里，开跑前先把当前档位落到它读的那份配置。
  const subagentRouter = getSubagentRouterConfig();
  syncOpenCodeSubagentRouter(subagentRouter);
  if (loadedSkills.length) {
    options.onStatus?.({
      phase: 'skill',
      detail: `正在加载 ${loadedSkills.length} 个共享技能…`
    });
  }
  const result = await runOpenCodeQuestion(question, {
    conversationId,
    conversationContext: options.conversationContext,
    currentAttachments: options.currentAttachments,
    attachmentPaths,
    imagePaths: chatAttachmentImagePaths(options.currentAttachmentRows || []),
    skillCatalog,
    loadedSkills,
    enableChartGeneration: Boolean(options.enableChartGeneration),
    learningMemoryPrompt: options.learningMemoryPrompt,
    learningMemoryFingerprint: options.learningMemoryFingerprint,
    learningMemoryCount: options.learningMemoryCount,
    reasoningEffort: options.chatModel && options.chatModel !== 'arc'
      ? (options.thinkingId === 'off' ? 'default' : 'high')
      : options.modelRole === 'large' || options.reasoningEffort === 'high' ? 'high' : 'default',
    smallThinking: parseChatSmallThinking(options.smallThinking) ?? 'medium',
    thinkingId: options.thinkingId,
    modelRole: options.modelRole === 'storm' ? 'storm' : options.modelRole === 'large' ? 'large' : 'small',
    chatModel: normalizeChatModelId(options.chatModel || options.modelRole),
    subagentRouterHint: formatSubagentRouterHint(subagentRouter),
    unrestrictedTools: true,
    tools: { ...CHAT_TOOL_POLICY },
    workingDirectory,
    timeoutMs: CHAT_AGENT_TIMEOUT_MS,
    onStatus: options.onStatus,
    onStep: options.onAgentStep,
    onTextDelta: options.onTextDelta,
    onAnswerReset: options.onAnswerReset,
    onAnswerReplace: options.onAnswerReplace,
    onContextUsage: options.onContextUsage,
    signal: options.signal
  });

  return {
    answer: result.answer,
    sources: result.sources,
    graphSeedIds: result.graphSeedIds,
    confidence: result.confidence,
    intent: result.intent,
    agentSteps: result.steps,
    metrics: result.metrics
  };
}
