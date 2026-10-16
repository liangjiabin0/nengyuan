'use client';

import dynamic from 'next/dynamic';
import {
  Check,
  ChevronDown,
  Link2,
  ListOrdered,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  Send,
  Square,
  Trash2,
  X
} from 'lucide-react';
import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { flushSync } from 'react-dom';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  CompactAttachmentManagerModal,
  CompactMessageAttachments,
  CompactPendingAttachments,
  attachmentTypeLabel,
  formatAttachmentSize
} from '@/components/attachment-chips';
import { ChatMarkdown } from '@/components/chat-markdown';
import { PowerComputePanel } from '@/components/power-compute-panel';
import { PowerTaskIndicator } from '@/components/power-task-indicator';
import { ChatModelMenu } from '@/components/chat-model-menu';
import { ChatMessageActions } from '@/components/chat-message-actions';
import { ChatComposerToolMenu, ComposerToolChip } from '@/components/chat-composer-tool-menu';
import { useDashboardStats } from '@/components/dashboard-stats-context';
import { invalidateDashboardListCache, readDashboardListCache } from '@/lib/dashboard-list-cache';
import { useNotifyError } from '@/components/app-notify';
import { useAuth } from '@/components/auth-provider';
import { notify } from '@/lib/notify';
import {
  createSendQueueItem,
  deleteSendQueueItem,
  fetchSendQueue,
  peekNextSendQueueItem,
  type ChatQueuedTurn
} from '@/lib/chat-send-queue';
import { usePageContentReady } from '@/components/page-nav-loading';
import {
  CHART_GENERATION_WELCOME_PROMPTS,
  PATENT_WELCOME_PROMPTS,
  RESEARCH_REVIEW_WELCOME_PROMPTS,
  composerToolFromSearch,
  conversationKindForTool,
  type ComposerToolId
} from '@/lib/chat-composer-tools';
import { createId } from '@/lib/create-id';
import {
  extractLinkCitations,
  findSourceForPath,
  linkifyOpenCodeCitations,
  normalizeCitationPath,
  normalizeCitationUrl,
  parsePathCitationId,
  resolveLinkCitations
} from '@/lib/opencode/citation-format';
import {
  filesFromClipboard,
  normalizeClipboardFile
} from '@/lib/attachments/clipboard';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_FORMAT_HINT,
  ATTACHMENT_IMAGE_EXTENSION_SET,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_UPLOAD_FILES,
  ATTACHMENT_UPLOAD_EXTENSION_SET,
  CHAT_ATTACHMENT_HINT
} from '@/lib/attachments/policy';
import {
  defaultChatThinkingRatio,
  fallbackThinkingLevels,
  parseChatThunder,
  resolveChatReasoningTier,
  snapChatReasoningRatio,
  type ThinkingLevel
} from '@/lib/reasoning-tier';
import {
  CHAT_MODEL_IDS,
  chatModelFromEndpointRole,
  DEFAULT_CHAT_MODEL,
  endpointRoleForChatModel,
  formatModelTierLabel,
  isChatModelId,
  normalizeChatModelId,
  parseChatModelId,
  type ChatModelId
} from '@/lib/model-ids';
import type { ChatWorkbenchConfig } from '@/lib/chat-workbench-config';
import { RESEARCH_REVIEW_API_BASE, RESEARCH_REVIEW_KIND } from '@/lib/research-review/constants';
import { ContextUsageIndicator } from '@/components/context-usage-indicator';
import { ChatTurnClock } from '@/components/chat-turn-clock';
import {
  freezeThinkingDurationMs,
  isPositiveMs,
  previousUserCreatedAt
} from '@/lib/chat-thinking-duration';
import {
  isInFlightAssistantMessage,
  readActiveConversation,
  readUnreadCompletedConversations,
  writeActiveConversation,
  writeUnreadCompletedConversations
} from '@/lib/chat-active-session';
import {
  clearComposerDraft,
  composerDraftKey,
  fileFromDraftBlob,
  readComposerDraft,
  writeComposerDraft,
  type ComposerDraftAttachment
} from '@/lib/chat-composer-draft';
import {
  classifyDisconnectedChatRun,
  fetchConversationRunState,
  isNetworkDisconnectError,
  normalizeStreamError,
  shouldReuseActiveGeneration
} from '@/lib/chat-stream-client';
import type { ChatLiveEvent } from '@/lib/chat-live-protocol';
import {
  consumeChatLive,
  isChatLiveEventFromRun,
  isIncrementalStreamEvent,
  reconcileStreamAfterSnapshot,
  shouldApplyRemoteStream,
  shouldRefreshActiveConversation,
  shouldRefreshConversationList,
  shouldRefreshSendQueue,
  shouldSeedRemoteTurn
} from '@/lib/chat-live-client';
import {
  newerConversationTimestamp,
  sortConversationsByLastUser
} from '@/lib/chat-conversation-list';
import {
  canApplyConversationLoad,
  canApplyRemoteConversationHydration,
  canRefreshViewedConversation,
  shouldUpdateActiveConversationTitle
} from '@/lib/chat-conversation-load';
import {
  ATTACHMENT_SIDE_PLUGIN_ID,
  ChatAttachmentPluginPanel,
  ChatKnowledgePluginPanel,
  ChatQueuePluginPanel,
  ChatSidePluginRail,
  KNOWLEDGE_SIDE_PLUGIN_ID,
  QUEUE_SIDE_PLUGIN_ID,
  type ChatSidePlugin
} from '@/components/chat-side-plugin-rail';
import { ChatAskCard } from '@/components/chat-ask-card';
import {
  SubagentSessionPanel,
  SubagentSheetHostContext,
  TaskSubagentButton,
  parentTranscriptSteps,
  taskNodeFromStep
} from '@/components/chat-agent-nodes';
import { RagThinkCollapse } from '@/components/rag-think-collapse';
import { StickToBottomFrame } from '@/components/stick-to-bottom';
import {
  childAgentPanelContent,
  collectVisibleChatAgentNodes,
  isTaskToolName,
  splitTrailingPublicAnswer
} from '@/lib/opencode/chat-subagents';
import {
  isPendingQuestionStep,
  isQuestionToolName,
  mergePendingAskIntoSteps,
  pendingChatAskRequests,
  summarizeQuestionTool,
  type ChatAskRequest
} from '@/lib/opencode/chat-ask';
import { contextUsageFromMetrics, hasRecognizedContextUsage } from '@/lib/opencode/context-usage';
import type { ChatReproProgress } from '@/lib/opencode/chat-repro-types';
import { inferParentSessionId } from '@/lib/opencode/chat-subagents';
import { applyCollapseGuard } from '@/lib/opencode/run-guards';
import { summarizeInvalidTool, summarizeWebTool } from '@/lib/opencode/tool-summary';
import { summarizeGatewayRetryThought } from '@/lib/opencode/gateway-retry-trace';
import { mergeRuntimeAgentStep, sortRuntimeAgentSteps } from '@/lib/opencode/agent-step-order';
import type { ModelContextUsage, RuntimeAgentStep } from '@/lib/opencode/types';

const KnowledgeGraphModal = dynamic(
  () => import('@/components/chat-knowledge-graph-modal').then((mod) => mod.KnowledgeGraphModal),
  { ssr: false }
);
const PatentWorkbench = dynamic(
  () => import('@/components/patent-workbench').then((mod) => mod.PatentWorkbench),
  {
    ssr: false,
    loading: () => <div className="rag-chat-card min-h-0 flex-1" />
  }
);

export type { ChatWorkbenchConfig };

const DEFAULT_CHAT_PANEL_WIDTH = 360;
const MIN_CHAT_PANEL_WIDTH = 300;
const MAX_CHAT_PANEL_WIDTH = 720;
const COMPOSER_MAX_VISIBLE_LINES = 4;

function syncComposerTextareaHeight(el: HTMLTextAreaElement, maxLines = COMPOSER_MAX_VISIBLE_LINES) {
  const style = window.getComputedStyle(el);
  const fontSize = Number.parseFloat(style.fontSize) || 14;
  const parsedLineHeight = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
    ? parsedLineHeight
    : fontSize * 1.25;
  const paddingY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const borderY = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
  const singleLineHeight = lineHeight + paddingY + borderY;
  const maxHeight = lineHeight * maxLines + paddingY + borderY;
  const isEmpty = el.value.length === 0;

  el.style.overflowY = 'hidden';
  el.style.height = 'auto';
  const contentHeight = isEmpty ? singleLineHeight : el.scrollHeight + borderY;
  if (isEmpty || contentHeight <= singleLineHeight + 0.5) {
    el.style.height = `${singleLineHeight}px`;
    return 1;
  }

  const next = Math.min(contentHeight, maxHeight);
  el.style.height = `${next}px`;
  el.style.overflowY = contentHeight > maxHeight + 0.5 ? 'auto' : 'hidden';
  return Math.max(2, Math.round((next - paddingY - borderY) / lineHeight));
}

const MIN_WORKSPACE_WIDTH = 680;
const MAX_ATTACHMENT_FILES = ATTACHMENT_MAX_UPLOAD_FILES;
const MAX_ATTACHMENT_BYTES = ATTACHMENT_MAX_BYTES;
const ATTACHMENT_ONLY_QUESTION = '请阅读并概括这些附件';
const RESEARCH_REVIEW_ATTACHMENT_ONLY_QUESTION = '请基于这些文献撰写研究综述';
const ALLOWED_ATTACHMENT_EXTENSIONS = ATTACHMENT_UPLOAD_EXTENSION_SET;
type ChatConversationKind = 'chat' | 'research-review';
const WELCOME_PROMPTS = [
  '今天想研究什么？',
  '有什么科研问题想探索？',
  '从哪个方向开始检索？',
  '想查哪类论文或项目？',
  '准备好一起挖数据了吗？',
  '先从哪个课题问起？'
];

export const DEFAULT_CHAT_WORKBENCH: ChatWorkbenchConfig = {
  apiBase: '/api/chat',
  title: '能元Agent',
  kicker: 'Dashboard / Chat',
  subtitle: '用于检索本地学科知识库，并围绕科研问题进行对话问答。',
  panelStorageKey: 'rag-chat-panel-width',
  welcomePrompts: WELCOME_PROMPTS
};

function pickWelcomePrompt(prompts: string[] = WELCOME_PROMPTS) {
  const list = prompts.length ? prompts : WELCOME_PROMPTS;
  return list[Math.floor(Math.random() * list.length)];
}

function welcomePromptsForTool(tool: ComposerToolId | null, fallback: string[] = WELCOME_PROMPTS) {
  if (tool === 'research-review') return RESEARCH_REVIEW_WELCOME_PROMPTS;
  if (tool === 'patent') return PATENT_WELCOME_PROMPTS;
  if (tool === 'chart-generation') return CHART_GENERATION_WELCOME_PROMPTS;
  return fallback.length ? fallback : WELCOME_PROMPTS;
}

function WelcomeTypewriter({ text, ready }: { text: string; ready: boolean }) {
  const [shown, setShown] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!ready || !text) {
      setShown('');
      setDone(false);
      return;
    }

    setShown('');
    setDone(false);
    let index = 0;
    const timer = window.setInterval(async () => {
      index += 1;
      setShown(text.slice(0, index));
      if (index >= text.length) {
        window.clearInterval(timer);
        setDone(true);
      }
    }, 72);

    return () => window.clearInterval(timer);
  }, [ready, text]);

  if (!ready) return null;

  return (
    <p className="relative whitespace-nowrap text-xl font-medium tracking-tight text-muted-foreground">
      {shown}
      {!done ? (
        <span className="rag-welcome-caret absolute left-full top-1/2 -translate-y-1/2" aria-hidden />
      ) : (
        <span
          className="absolute left-full top-1/2 ml-2.5 -translate-y-1/2"
          title="能元已连接"
          aria-label="能元已连接"
        >
          <span className="rag-oc-status-dot" />
        </span>
      )}
    </p>
  );
}

type Source = {
  id?: string;
  label?: string;
  title: string;
  fileName?: string;
  sourceType: string;
  sourceKey: string;
  fileKey?: string;
  filePath?: string;
  fileKind?: 'pdf' | 'markdown' | 'text' | 'none';
  previewUrl?: string;
  snippet: string;
  score: number;
  matchReason?: string;
  corpusPath?: string;
  pathAliases?: string[];
  url?: string;
  evidenceIds?: string[];
};

function isLinkSource(source: Source) {
  return source.sourceType === 'link'
    || /^L\d+$/i.test(String(source.id || ''))
    || /^https?:\/\//i.test(String(source.url || source.previewUrl || source.filePath || ''));
}

function linkSourceUrl(source: Source) {
  const candidate = source.url || source.previewUrl || source.filePath || '';
  return /^https?:\/\//i.test(candidate) ? candidate : '';
}

type ResearchReviewArtifact = {
  id: string;
  conversationId: string;
  messageId: string;
  fileName: string;
  byteSize: number;
  reportTitle: string;
  qualityScore: number;
  qualityMax: number;
  qualityOk: boolean;
  createdAt: string;
  downloadUrl: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  artifacts?: ResearchReviewArtifact[];
  sources?: Source[];
  graphSeedIds?: string[];
  agentSteps?: AgentStep[];
  thinkingDurationMs?: number;
  startedAt?: number;
  createdAt?: string;
  contextUsage?: ModelContextUsage;
  inProgress?: boolean;
  /** 这一轮实际用的模型与思考档，气泡下方标注用。 */
  chatModel?: ChatModelId;
  thinkingId?: string;
};
type Conversation = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_user_at?: string;
  messageCount?: number;
  kind?: ChatConversationKind;
  skillIds?: string[];
  thunder?: boolean;
  chat_model?: ChatModelId;
  generating?: boolean;
};

type ChatAttachment = {
  id: string;
  conversationId: string;
  messageId?: string;
  name: string;
  mediaType: string;
  extension: string;
  size: number;
  status: 'processing' | 'ready' | 'failed';
  error?: string;
  metadata?: Record<string, unknown>;
  previewUrl: string;
  downloadUrl: string;
  createdAt: string;
  deduplicated?: boolean;
};

type PendingAttachmentStatus = 'queued' | 'uploading' | 'processing' | 'ready' | 'failed' | 'removing';

type PendingAttachment = {
  clientId: string;
  file: File;
  name: string;
  extension: string;
  mediaType: string;
  size: number;
  status: PendingAttachmentStatus;
  progress: number;
  error?: string;
  /** ZIP is stored as one original file; the agent decides whether to extract. */
  attachments?: ChatAttachment[];
  attachment?: ChatAttachment;
};

function pendingAttachmentRecords(pending: PendingAttachment) {
  if (pending.attachments?.length) return pending.attachments;
  return pending.attachment ? [pending.attachment] : [];
}

function isLocalReadyPending(pending: PendingAttachment) {
  return pending.status === 'ready';
}

function toDraftAttachment(attachment: ChatAttachment): ComposerDraftAttachment {
  return {
    id: attachment.id,
    conversationId: attachment.conversationId,
    name: attachment.name,
    extension: attachment.extension,
    mediaType: attachment.mediaType,
    size: attachment.size,
    status: attachment.status,
    previewUrl: attachment.previewUrl,
    downloadUrl: attachment.downloadUrl,
    createdAt: attachment.createdAt,
    deduplicated: attachment.deduplicated,
    metadata: attachment.metadata,
    error: attachment.error
  };
}

function fromDraftAttachment(attachment: ComposerDraftAttachment): ChatAttachment {
  return {
    id: attachment.id,
    conversationId: attachment.conversationId,
    name: attachment.name,
    extension: attachment.extension,
    mediaType: attachment.mediaType,
    size: attachment.size,
    status: attachment.status === 'failed' || attachment.status === 'processing' ? attachment.status : 'ready',
    previewUrl: attachment.previewUrl,
    downloadUrl: attachment.downloadUrl || attachment.previewUrl,
    createdAt: attachment.createdAt || '',
    deduplicated: attachment.deduplicated,
    metadata: attachment.metadata,
    error: attachment.error
  };
}

function placeholderAttachmentFile(attachment: ChatAttachment) {
  return new File([], attachment.name, { type: attachment.mediaType || 'application/octet-stream' });
}

function pendingFromMessageAttachments(attachments: ChatAttachment[]): PendingAttachment[] {
  return attachments.map((attachment) => ({
    clientId: createId(),
    file: placeholderAttachmentFile(attachment),
    name: attachment.name,
    extension: attachment.extension,
    mediaType: attachment.mediaType,
    size: attachment.size,
    status: attachment.status === 'failed' ? 'failed' : 'ready',
    progress: 100,
    error: attachment.error,
    attachment,
    attachments: [attachment]
  }));
}

function sortByCreatedAtDesc<T extends { createdAt?: string }>(items: T[]) {
  return [...items].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** 右侧「附件查看」只收 AI 交付的文件，不含用户上传。 */
function collectAssistantDeliveredFiles(messages: ChatMessage[]) {
  const userAttachmentIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const attachment of message.attachments || []) {
      userAttachmentIds.add(attachment.id);
    }
  }

  const attachments = new Map<string, ChatAttachment>();
  const artifacts = new Map<string, ResearchReviewArtifact>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const attachment of message.attachments || []) {
      const role = String(attachment.metadata?.role || '').toLowerCase();
      const explicitlyDelivered = role === 'agent-deliverable' || role === 'generated-chart';
      // The side rail is an AI delivery surface, not a second upload list.
      // Require an explicit delivery role and always suppress files that were
      // attached to a user message, even if old metadata was inconsistent.
      if (!explicitlyDelivered || userAttachmentIds.has(attachment.id) || attachments.has(attachment.id)) continue;
      attachments.set(attachment.id, attachment);
    }
    for (const artifact of message.artifacts || []) {
      artifacts.set(artifact.id, artifact);
    }
  }

  return {
    attachments: sortByCreatedAtDesc([...attachments.values()]),
    artifacts: sortByCreatedAtDesc([...artifacts.values()])
  };
}

type AgentStep = RuntimeAgentStep;

type StreamEvent =
  | {
      type: 'meta';
      conversationId: string;
      title: string;
      sources: Source[];
      graphSeedIds: string[];
      confidence?: 'high' | 'medium' | 'low';
      intent?: string;
      trace?: Partial<ModelContextUsage> & { totalDurationMs?: number };
      agentSteps?: AgentStep[];
      chatModel?: ChatModelId;
      reasoningRatio?: number;
      thinkingId?: string;
    }
  | { type: 'status'; phase: string; detail: string; message?: string }
  | { type: 'agent_step'; step: AgentStep }
  | { type: 'context_usage'; usage: ModelContextUsage }
  | { type: 'chunk'; content: string }
  | { type: 'answer_reset' }
  | { type: 'answer_replace'; content: string }
  | { type: 'artifact'; artifact: ResearchReviewArtifact }
  | { type: 'title'; conversationId: string; title: string }
  | { type: 'done'; conversationId?: string; metrics?: Partial<ModelContextUsage> & { totalDurationMs?: number }; artifact?: ResearchReviewArtifact; attachments?: ChatAttachment[] }
  | { type: 'error'; error: string };

type RemoteSyncState = {
  conversationId: string;
  assistantId: string;
  queued: StreamEvent[];
  ready: boolean;
  syncing: Promise<void> | null;
};


const initialMessages: ChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content: '**研究院智能问答**已就绪（**能元**驱动）。\n\nAgent 可检索本地语料与联网资料，也可以写脚本、改文件、调用 sidecar 已接入的全部工具。检索步骤与参考来源会显示在回答气泡内。'
  }
];

function previewSubagentMessages(): ChatMessage[] {
  const parent = 'ses_parentPreview';
  const child = 'ses_childPreview';
  return [
    {
      id: 'preview-user',
      role: 'user',
      content: '复现这篇论文'
    },
    {
      id: 'preview-assistant',
      role: 'assistant',
      content: '已按节点派子代理完成实现阶段，结果见上。',
      thinkingDurationMs: 42_000,
      agentSteps: [
        {
          type: 'thought',
          step: 1,
          sessionId: parent,
          content: '先写计划，再按实验拆子代理。'
        },
        {
          type: 'tool_call',
          step: 2,
          tool: 'task',
          sessionId: parent,
          nodeId: '实现 SVGP',
          parentToolCallId: 'call_preview_a',
          input: { description: '实现 SVGP' },
          content: '已派子代理：实现 SVGP'
        },
        {
          type: 'thought',
          step: 3,
          sessionId: child,
          nodeId: '实现 SVGP',
          parentToolCallId: 'call_preview_a',
          content: '正在实现核函数，并核对论文公式。'
        },
        {
          type: 'tool_call',
          step: 4,
          tool: 'read',
          sessionId: child,
          nodeId: '实现 SVGP',
          parentToolCallId: 'call_preview_a',
          input: { path: 'repro/tste-svgp/paper.md' },
          content: '读取 paper.md'
        }
      ]
    }
  ];
}

function unescapeLlmMathDelimiters(content: string) {
  return content
    .replace(/\\\\\[/g, '\\[')
    .replace(/\\\\\]/g, '\\]')
    .replace(/\\\\\(/g, '\\(')
    .replace(/\\\\\)/g, '\\)');
}

function convertLatexDelimiters(content: string) {
  return content
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => `\n$$\n${String(math).trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, math) => `$${String(math).trim()}$`);
}

function protectCurrencyDollars(content: string) {
  return content
    .replace(/\\\$/g, '§DOLLAR§')
    .replace(/(?<!\\)(?<!\$)\$(?=\d)/g, '\\$');
}

function restoreEscapedDollars(content: string) {
  return content.replace(/§DOLLAR§/g, '\\$');
}

function sealIncompleteMathDelimiters(content: string) {
  let open = 0;
  let index = 0;
  while (index < content.length) {
    if (content[index] === '\\' && (content[index + 1] === '$' || content[index + 1] === '(' || content[index + 1] === '[')) {
      index += 2;
      continue;
    }
    if (content[index] === '$') {
      let markerCount = 0;
      while (index < content.length && content[index] === '$') {
        markerCount += 1;
        index += 1;
      }
      if (open === 0) open = markerCount;
      else if (markerCount === open) open = 0;
      continue;
    }
    index += 1;
  }
  let sealed = open > 0 ? `${content}${'$'.repeat(open)}` : content;
  const openParen = (sealed.match(/\\\(/g) || []).length - (sealed.match(/\\\)/g) || []).length;
  if (openParen > 0) sealed += '\\)'.repeat(openParen);
  const openBracket = (sealed.match(/\\\[/g) || []).length - (sealed.match(/\\\]/g) || []).length;
  if (openBracket > 0) sealed += '\\]'.repeat(openBracket);
  return sealed;
}

function prepareMathMarkdown(content: string, streaming = false) {
  let text = unescapeLlmMathDelimiters(content);
  text = protectCurrencyDollars(text);
  text = convertLatexDelimiters(text);
  text = restoreEscapedDollars(text);
  if (streaming) text = sealIncompleteMathDelimiters(text);
  return text;
}

function normalizeMarkdown(content: string, streaming = false) {
  return prepareMathMarkdown(content, streaming)
    .replace(/\*\*\*\*/g, '**')
    .replace(/(\*\*[^*\n]+[：:；;]\*\*)(?=\S)/g, '$1 ');
}

function isMathCodeClass(className: unknown) {
  return typeof className === 'string' && (className.includes('math-inline') || className.includes('math-display') || className.includes('language-math'));
}

/** Ensure web URLs in the answer become L1/L2 sources even if the server missed them. */
function enrichSourcesWithLinks(content: string, sources: Source[] = []): Source[] {
  const urls = extractLinkCitations(content);
  if (!urls.length) return sources;

  const byUrl = new Map<string, Source>();
  let maxL = 0;
  for (const source of sources) {
    const idMatch = String(source.id || '').match(/^L(\d+)$/i);
    if (idMatch) maxL = Math.max(maxL, Number(idMatch[1]));
    if (!isLinkSource(source)) continue;
    const url = normalizeCitationUrl(linkSourceUrl(source));
    if (url) byUrl.set(url, source);
  }

  const extras: Source[] = [];
  for (const url of urls) {
    const key = normalizeCitationUrl(url);
    if (!key || byUrl.has(key)) continue;
    maxL += 1;
    const [built] = resolveLinkCitations([url], maxL);
    if (!built) continue;
    const next: Source = { ...built, id: `L${maxL}`, label: `L${maxL}`, fileKey: `link:L${maxL}`, evidenceIds: [`L${maxL}`] };
    extras.push(next);
    byUrl.set(key, next);
  }
  return extras.length ? [...sources, ...extras] : sources;
}

function linkifyCitations(content: string, sources: Source[] = []) {
  return linkifyOpenCodeCitations(content, enrichSourcesWithLinks(content, sources));
}

function assistantMessageSources(message: Pick<ChatMessage, 'content' | 'sources'>) {
  return enrichSourcesWithLinks(message.content || '', message.sources || []);
}

function truncateTitle(title: string, max = 42) {
  const compact = title.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function findSourceByCitationId(sources: Source[], citationId: string) {
  const normalized = citationId.toUpperCase();
  const direct = sources.find((source) =>
    String(source.id || '').toUpperCase() === normalized
    || (source.evidenceIds || []).some((id) => id.toUpperCase() === normalized)
  );
  if (direct) return direct;

  const pathCite = parsePathCitationId(citationId);
  if (!pathCite) return undefined;
  return findSourceForPath(
    sources,
    pathCite.path,
    String(pathCite.startLine),
    String(pathCite.endLine)
  );
}

function chipLabel(source: Source) {
  return source.fileName || truncateTitle(source.title, 32);
}

function citationLabel(source: Source) {
  if (source.label) return source.label;
  if (source.id) return source.id;
  return isLinkSource(source) ? 'L?' : 'E?';
}

function salvageAnswerFromSteps(steps?: AgentStep[]) {
  if (!steps?.length) return '';
  const parentSessionId = inferParentSessionId(steps);
  const texts = parentTranscriptSteps(steps, parentSessionId)
    .filter((step) => step.type === 'public_text')
    .map((step) => applyCollapseGuard(String(step.content || '')).text.trim())
    .filter(Boolean);
  return texts[texts.length - 1] || '';
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition ${expanded ? 'rotate-180' : ''}`}
      aria-hidden
    >
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z" clipRule="evenodd" />
    </svg>
  );
}

function EvidenceChip({ source, onClick, compact = false }: { source: Source; onClick: () => void; compact?: boolean }) {
  const link = isLinkSource(source);
  const badgeClass = link
    ? (compact ? 'text-blue-800' : 'text-blue-300')
    : (compact ? 'text-emerald-800' : 'text-emerald-300');
  if (compact) {
    return (
      <button type="button" onClick={onClick} className="rag-evidence-chip-compact" title={`${citationLabel(source)} · ${source.title}`}>
        <span className={`shrink-0 font-semibold ${badgeClass}`}>{citationLabel(source)}</span>
        <span className="truncate">{chipLabel(source)}</span>
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} className="rag-evidence-chip" title={`${citationLabel(source)} · ${source.title}`}>
      <span className={`shrink-0 font-semibold ${badgeClass}`}>{citationLabel(source)}</span>
      <span className="truncate text-slate-300">{chipLabel(source)}</span>
    </button>
  );
}

function CollapsibleReferences({
  sources,
  onSourceClick
}: {
  sources: Source[];
  onSourceClick: (source: Source) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!sources.length) return null;

  return (
    <div className="rag-refs-block mt-3 border-t border-slate-100 pt-2">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="rag-refs-toggle">
        <span>参考文献</span>
        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{sources.length}</span>
        <ChevronIcon expanded={expanded} />
      </button>
      {!expanded ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {sources.slice(0, 4).map((source) => (
            <EvidenceChip key={`compact-${source.id || source.sourceKey}`} source={source} onClick={() => onSourceClick(source)} compact />
          ))}
          {sources.length > 4 ? <span className="px-1 text-[10px] text-slate-400">+{sources.length - 4}</span> : null}
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {sources.map((source) => (
            <button
              key={`expanded-${source.id || source.sourceKey}`}
              type="button"
              onClick={() => onSourceClick(source)}
              className="rag-evidence-row"
            >
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  isLinkSource(source) ? 'bg-blue-100 text-blue-800' : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                {citationLabel(source)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-slate-800">{chipLabel(source)}</span>
                {source.snippet ? <span className="mt-0.5 line-clamp-2 text-[10px] leading-4 text-slate-500">{source.snippet}</span> : null}
                {source.matchReason ? <span className="mt-0.5 block text-[10px] text-emerald-600">{source.matchReason}</span> : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EvidenceModal({ source, onClose }: { source: Source; onClose: () => void }) {
  const [previewKind, setPreviewKind] = useState<'pdf' | 'markdown' | 'text' | 'loading' | 'error'>('loading');
  const [previewContent, setPreviewContent] = useState('');
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    async function loadPreview() {
      if (!source.previewUrl) {
        setPreviewKind('text');
        setPreviewContent(source.snippet || '暂无预览内容。');
        return;
      }

      if (source.fileKind === 'pdf') {
        setPreviewKind('pdf');
        return;
      }

      try {
        const response = await fetch(source.previewUrl);
        if (!response.ok) throw new Error('预览加载失败');
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/pdf')) {
          if (!cancelled) setPreviewKind('pdf');
          return;
        }
        const payload = await response.json() as { kind?: string; content?: string; error?: string };
        if (payload.error) throw new Error(payload.error);
        if (!cancelled) {
          setPreviewKind(payload.kind === 'markdown' ? 'markdown' : 'text');
          setPreviewContent(payload.content || source.snippet || '');
        }
      } catch (error) {
        if (!cancelled) {
          setPreviewKind('error');
          setPreviewError(error instanceof Error ? error.message : '预览失败');
        }
      }
    }

    setPreviewKind('loading');
    setPreviewContent('');
    setPreviewError('');
    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [source]);

  const previewSrc = source.previewUrl || '';

  return (
    <div className="rag-evidence-modal-backdrop" onClick={onClose}>
      <div className="rag-evidence-modal rag-evidence-modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                  isLinkSource(source) ? 'bg-blue-100 text-blue-800' : 'bg-emerald-100 text-emerald-800'
                }`}
              >
                {citationLabel(source)}
              </span>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-600">{source.fileKind || source.sourceType}</span>
              {source.evidenceIds?.length ? (
                <span className="text-[11px] text-slate-400">引用 {source.evidenceIds.join('、')}</span>
              ) : null}
            </div>
            <h3 className="mt-2 text-base font-semibold leading-6 text-slate-900">{chipLabel(source)}</h3>
            <p className="mt-1 text-xs text-slate-500">{source.title}</p>
            {source.matchReason ? <p className="mt-1 text-xs text-emerald-600">{source.matchReason}</p> : null}
          </div>
          <div className="flex items-center gap-2">
            {previewSrc ? (
              <a href={previewSrc} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">新窗口打开</a>
            ) : null}
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50">关闭</button>
          </div>
        </div>
        <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-hidden">
          {previewKind === 'loading' ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">正在加载文件预览…</div>
          ) : null}
          {previewKind === 'error' ? (
            <div className="px-5 py-10 text-center text-sm text-rose-600">{previewError}</div>
          ) : null}
          {previewKind === 'pdf' && previewSrc ? (
            <iframe title={source.title} src={previewSrc} className="h-[calc(min(86vh,820px)-88px)] w-full bg-slate-100" />
          ) : null}
          {previewKind === 'markdown' ? (
            <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-y-auto px-5 py-4">
              <MessageContent content={previewContent} />
            </div>
          ) : null}
          {previewKind === 'text' ? (
            <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-y-auto px-5 py-4">
              <pre className="whitespace-pre-wrap text-sm leading-7 text-slate-700">{previewContent}</pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function attachmentExtension(name: string) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function pendingAttachmentStatusLabel(attachment: PendingAttachment) {
  if (attachment.status === 'queued') return '等待上传';
  if (attachment.status === 'uploading') return `上传中 ${attachment.progress}%`;
  if (attachment.status === 'processing') return '正在解析';
  if (attachment.status === 'ready') return '已就绪';
  if (attachment.status === 'removing') return '正在删除';
  return attachment.error || '上传失败';
}

function isImageAttachment(attachment: Pick<ChatAttachment, 'extension' | 'mediaType'>) {
  const extension = attachment.extension.toLowerCase();
  return attachment.mediaType.startsWith('image/')
    || ATTACHMENT_IMAGE_EXTENSION_SET.has(extension);
}

function isPendingImage(attachment: Pick<PendingAttachment, 'extension' | 'mediaType'>) {
  return isImageAttachment(attachment);
}

function PendingImageThumb({
  pending,
  onOpen,
  onRemove
}: {
  pending: PendingAttachment;
  onOpen: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}) {
  const [src, setSrc] = useState('');

  useEffect(() => {
    if (pending.attachment?.previewUrl && pending.status === 'ready') {
      setSrc(pending.attachment.previewUrl);
      return;
    }
    const url = URL.createObjectURL(pending.file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [pending.attachment?.previewUrl, pending.file, pending.status]);

  return (
    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
      <button
        type="button"
        onClick={() => {
          if (pending.status === 'ready') onOpen(pending.clientId);
        }}
        className="block h-full w-full"
        aria-label={pending.status === 'ready' ? `预览 ${pending.name}` : pending.name}
      >
        {src ? (
          <img src={src} alt={pending.name} className="h-full w-full object-cover" />
        ) : null}
      </button>
      {pending.status !== 'removing' ? (
        <button
          type="button"
          onClick={() => onRemove(pending.clientId)}
          className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-sm bg-background/90 text-muted-foreground hover:text-destructive"
          aria-label={`移除附件 ${pending.name}`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function AttachmentPreviewModal({ attachment, onClose }: { attachment: ChatAttachment; onClose: () => void }) {
  const [previewKind, setPreviewKind] = useState<'pdf' | 'html' | 'markdown' | 'text' | 'image' | 'loading' | 'error'>('loading');
  const [previewContent, setPreviewContent] = useState('');
  const [previewTitle, setPreviewTitle] = useState(attachment.name);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    async function loadPreview() {
      if (attachment.status !== 'ready') {
        setPreviewKind('error');
        setPreviewError(attachment.error || '附件尚未准备好。');
        return;
      }
      if (attachment.extension.toLowerCase() === '.pdf') {
        setPreviewKind('pdf');
        return;
      }
      if (['.html', '.htm'].includes(attachment.extension.toLowerCase())) {
        setPreviewKind('html');
        return;
      }
      if (isImageAttachment(attachment)) {
        setPreviewKind('image');
        return;
      }
      try {
        const response = await fetch(attachment.previewUrl);
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(payload.error || '附件预览加载失败');
        }
        if (contentType.includes('application/pdf')) {
          if (!cancelled) setPreviewKind('pdf');
          return;
        }
        const payload = await response.json() as {
          kind?: string;
          title?: string;
          fileName?: string;
          content?: string;
          error?: string;
        };
        if (payload.error) throw new Error(payload.error);
        if (!cancelled) {
          setPreviewKind(payload.kind === 'markdown' ? 'markdown' : 'text');
          setPreviewTitle(payload.title || payload.fileName || attachment.name);
          setPreviewContent(payload.content || '');
        }
      } catch (error) {
        if (!cancelled) {
          setPreviewKind('error');
          setPreviewError(error instanceof Error ? error.message : '附件预览失败');
        }
      }
    }

    setPreviewKind('loading');
    setPreviewContent('');
    setPreviewTitle(attachment.name);
    setPreviewError('');
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [attachment]);

  return (
    <div className="rag-evidence-modal-backdrop" onClick={onClose}>
      <div
        className="rag-evidence-modal rag-evidence-modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={`预览附件 ${attachment.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                {attachmentTypeLabel(attachment)}
              </span>
              <span className="text-[11px] text-slate-400">{formatAttachmentSize(attachment.size)}</span>
            </div>
            <h3 className="mt-2 truncate text-base font-semibold leading-6 text-slate-900">{previewTitle}</h3>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={attachment.downloadUrl || (attachment.previewUrl.includes('?') ? `${attachment.previewUrl}&download=1` : `${attachment.previewUrl}?download=1`)}
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              下载
            </a>
            <a
              href={['.html', '.htm'].includes(attachment.extension.toLowerCase())
                ? (attachment.previewUrl.includes('?') ? `${attachment.previewUrl}&inline=1` : `${attachment.previewUrl}?inline=1`)
                : attachment.previewUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              新窗口打开
            </a>
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50">
              关闭
            </button>
          </div>
        </div>
        <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-hidden">
          {previewKind === 'loading' ? <div className="px-5 py-10 text-center text-sm text-slate-500">正在加载附件预览…</div> : null}
          {previewKind === 'error' ? <div className="px-5 py-10 text-center text-sm text-rose-600">{previewError}</div> : null}
          {previewKind === 'pdf' ? (
            <iframe title={attachment.name} src={attachment.previewUrl} className="h-[calc(min(86vh,820px)-88px)] w-full bg-slate-100" />
          ) : null}
          {previewKind === 'html' ? (
            <iframe
              title={attachment.name}
              src={attachment.previewUrl.includes('?') ? `${attachment.previewUrl}&inline=1` : `${attachment.previewUrl}?inline=1`}
              sandbox=""
              className="h-[calc(min(86vh,820px)-88px)] w-full bg-white"
            />
          ) : null}
          {previewKind === 'image' ? (
            <div className="flex max-h-[calc(min(86vh,820px)-88px)] items-center justify-center overflow-auto bg-slate-100 p-4">
              <img src={attachment.previewUrl} alt={attachment.name} className="max-h-[calc(min(86vh,820px)-120px)] max-w-full object-contain" />
            </div>
          ) : null}
          {previewKind === 'markdown' ? (
            <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-y-auto px-5 py-4">
              <MessageContent content={previewContent} />
            </div>
          ) : null}
          {previewKind === 'text' ? (
            <div className="max-h-[calc(min(86vh,820px)-88px)] overflow-y-auto px-5 py-4">
              <pre className="whitespace-pre-wrap text-sm leading-7 text-slate-700">{previewContent}</pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Excel 式自动列宽：按列内「表头 + 单元格」最宽内容测算，超长列封顶后换行。 */
function autofitMarkdownTable(table: HTMLTableElement, containerWidth: number) {
  table.querySelectorAll('colgroup[data-autofit]').forEach((node) => node.remove());
  table.style.tableLayout = 'auto';
  table.style.width = 'max-content';

  const rows = Array.from(table.rows);
  if (!rows.length) return;

  let colCount = 0;
  for (const row of rows) {
    let count = 0;
    for (const cell of Array.from(row.cells)) count += cell.colSpan || 1;
    colCount = Math.max(colCount, count);
  }
  if (!colCount) return;

  const cells = Array.from(table.querySelectorAll('th, td')) as HTMLTableCellElement[];
  const prevWhiteSpace = cells.map((cell) => cell.style.whiteSpace);
  const prevMaxWidth = cells.map((cell) => cell.style.maxWidth);
  const prevWidth = cells.map((cell) => cell.style.width);

  for (const cell of cells) {
    cell.style.whiteSpace = 'nowrap';
    cell.style.maxWidth = 'none';
    cell.style.width = 'auto';
  }

  const widths = Array.from({ length: colCount }, () => 0);
  for (const row of rows) {
    let colIndex = 0;
    for (const cell of Array.from(row.cells)) {
      const span = cell.colSpan || 1;
      const contentWidth = Math.ceil(cell.scrollWidth);
      if (span <= 1) {
        widths[colIndex] = Math.max(widths[colIndex], contentWidth);
      } else {
        const share = Math.ceil(contentWidth / span);
        for (let i = 0; i < span; i += 1) {
          widths[colIndex + i] = Math.max(widths[colIndex + i], share);
        }
      }
      colIndex += span;
    }
  }

  cells.forEach((cell, index) => {
    cell.style.whiteSpace = prevWhiteSpace[index];
    cell.style.maxWidth = prevMaxWidth[index];
    cell.style.width = prevWidth[index];
  });

  // Excel AutoFit：最小约 2 字符宽，最大约 40 字符宽（随容器收紧）
  const minCol = 40;
  const maxCol = Math.max(120, Math.min(420, Math.floor(Math.max(containerWidth, 240) * 0.56)));
  const breathing = 2;
  let fitted = widths.map((width) => Math.min(maxCol, Math.max(minCol, width + breathing)));

  const total = fitted.reduce((sum, width) => sum + width, 0);
  if (total > 0 && containerWidth > 0 && total < containerWidth) {
    // 总宽不足容器时按比例匀摊多余空间，避免短表右侧留白
    const scale = containerWidth / total;
    fitted = fitted.map((width) => Math.max(minCol, Math.floor(width * scale)));
    const rounded = fitted.reduce((sum, width) => sum + width, 0);
    if (rounded < containerWidth) fitted[fitted.length - 1] += containerWidth - rounded;
  }

  const colgroup = document.createElement('colgroup');
  colgroup.setAttribute('data-autofit', '1');
  for (const width of fitted) {
    const col = document.createElement('col');
    col.style.width = `${width}px`;
    colgroup.appendChild(col);
  }
  table.insertBefore(colgroup, table.firstChild);
  table.style.tableLayout = 'fixed';
  table.style.width = `${fitted.reduce((sum, width) => sum + width, 0)}px`;
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  useLayoutEffect(() => {
    const table = tableRef.current;
    const wrap = wrapRef.current;
    if (!table || !wrap) return;

    let frame = 0;
    let fitting = false;

    const run = () => {
      if (fitting) return;
      fitting = true;
      try {
        autofitMarkdownTable(table, wrap.clientWidth);
      } finally {
        fitting = false;
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        run();
      });
    };

    run();

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(wrap);

    const mutationObserver = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => {
        const target = mutation.target as Node;
        if (target instanceof Element && target.closest('colgroup[data-autofit]')) return true;
        if (mutation.type === 'childList') {
          const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
          if (nodes.length && nodes.every((node) => node instanceof Element && node.matches?.('colgroup[data-autofit]'))) {
            return true;
          }
        }
        return false;
      })) {
        return;
      }
      schedule();
    });
    mutationObserver.observe(table, { childList: true, subtree: true, characterData: true });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [children]);

  return (
    <div ref={wrapRef} className="rag-md-table-wrap">
      <table ref={tableRef} className="rag-md-table text-sm">
        {children}
      </table>
    </div>
  );
}

function MessageContent({
  content,
  streaming = false,
  sources = [],
  onCitationClick,
  enableMath = false
}: {
  content: string;
  streaming?: boolean;
  sources?: Source[];
  onCitationClick?: (id: string) => void;
  enableMath?: boolean;
}) {
  return (
    <ChatMarkdown
      enableMath={enableMath}
      components={{
        table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
        thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
        th: ({ children }) => (
          <th className="px-3 py-2 text-left text-xs font-semibold text-slate-600">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border-t border-slate-100 px-3 py-2 align-top text-sm">
            {children}
          </td>
        ),
        h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold leading-7 text-slate-900 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 mt-3 text-[15px] font-semibold leading-7 text-slate-900 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-sm font-semibold leading-6 text-slate-800 first:mt-0">{children}</h3>,
        h4: ({ children }) => <h4 className="mb-1.5 mt-2 text-sm font-medium leading-6 text-slate-800 first:mt-0">{children}</h4>,
        p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0 leading-7">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        a: ({ href, children }) => {
          if (href?.startsWith('#cite-') && onCitationClick) {
            const id = href.replace('#cite-', '');
            const linkCite = /^L\d+$/i.test(id);
            return (
              <button
                type="button"
                onClick={() => onCitationClick(id)}
                className={linkCite ? 'rag-citation-link rag-citation-link-web' : 'rag-citation-link'}
              >
                {children}
              </button>
            );
          }
          if (href && /^https?:\/\//i.test(href)) {
            return (
              <a href={href} target="_blank" rel="noreferrer" className="font-medium text-blue-800 underline">
                {children}
              </a>
            );
          }
          return <a href={href} className="font-medium text-emerald-800 underline">{children}</a>;
        },
        code: ({ className, children, ...props }) => (
          isMathCodeClass(className)
            ? <code className={className} {...props}>{children}</code>
            : <code className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[0.9em] text-emerald-700">{children}</code>
        )
      }}
    >
      {linkifyCitations(normalizeMarkdown(content, streaming), sources)}
    </ChatMarkdown>
  );
}

function maxEvidenceNumber(messages: ChatMessage[]) {
  let max = 0;
  for (const message of messages) {
    for (const source of message.sources || []) {
      const match = String(source.id || '').match(/^E(\d+)$/i);
      if (match) max = Math.max(max, Number(match[1]));
    }
    for (const match of message.content.matchAll(/\[E(\d+)\]/gi)) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max;
}

function TypingIndicator({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const dot = size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2';
  return (
    <span className="inline-flex items-center gap-1.5 py-0.5" role="status" aria-label="正在生成">
      <span className={`${dot} animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.2s]`} />
      <span className={`${dot} animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:-0.1s]`} />
      <span className={`${dot} animate-bounce rounded-full bg-muted-foreground/50`} />
    </span>
  );
}

function normalizeThoughtText(content: string) {
  return content
    .replace(/^规则兜底[:：]\s*/, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain-text display for thinking prose — strip markdown that would look like mixed sizes. */
function sanitizeThoughtDisplay(content: string) {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .trim();
}

function visibleAgentSteps(steps: AgentStep[]) {
  return steps.filter((step) => {
    if (step.type === 'tool_call' && !step.tool) return false;
    if (step.type === 'observation' && /^【系统】/.test(step.content)) return false;
    return true;
  });
}

function fileLabel(value: string) {
  const normalized = value.replace(/\\/g, '/').trim();
  if (!normalized) return '';
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function compactDetail(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function bashCommandText(value: string) {
  return value.replace(/[ \t]+\n/g, '\n').replace(/\s+$/g, '').trimStart();
}

function summarizeThinkStep(step: AgentStep): { verb: string; detail: string; wrap?: boolean } | null {
  if (step.type === 'thought') {
    return summarizeGatewayRetryThought(step.content);
  }
  if (step.type === 'tool_call' && step.tool) {
    const input = step.input || {};
    const tool = step.tool;
    const contentFallback = (() => {
      const content = String(step.content || '').replace(/\s+/g, ' ').trim();
      if (!content) return '';
      // Prefer "skill：patent-disclosure" style payload from runtime.
      const stripped = content.replace(new RegExp(`^(调用\\s+)?${tool}：?`, 'i'), '').trim();
      return compactDetail(stripped || content);
    })();
    if (tool === 'invalid') return summarizeInvalidTool(input, contentFallback);
    if (tool === 'read') {
      const target = fileLabel(String(input.path || input.filePath || input.file || '')) || contentFallback;
      const offset = input.offset != null ? Number(input.offset) : NaN;
      const limit = input.limit != null ? Number(input.limit) : NaN;
      let range = '';
      if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
        range = ` L${offset}-${offset + limit - 1}`;
      } else if (Number.isFinite(offset)) {
        range = ` L${offset}+`;
      }
      return { verb: '读取', detail: `${target || '文件'}${range}` };
    }
    if (tool === 'grep') {
      const pattern = String(input.pattern || input.query || '') || contentFallback;
      const where = fileLabel(String(input.path || input.include || input.glob || '')) || '工作区';
      return { verb: '检索', detail: `${compactDetail(pattern)} @ ${where}` };
    }
    if (tool === 'glob') {
      const pattern = String(input.pattern || input.glob || '*') || contentFallback;
      const where = fileLabel(String(input.path || '')) || '工作区';
      return { verb: '匹配', detail: `${compactDetail(pattern)} @ ${where}` };
    }
    if (tool === 'list') {
      return { verb: '列出', detail: fileLabel(String(input.path || '.')) || contentFallback || '.' };
    }
    if (tool === 'bash') {
      const command = bashCommandText(String(input.command || input.cmd || input.script || '') || contentFallback);
      return { verb: '执行', detail: command || '命令', wrap: true };
    }
    if (tool === 'skill') {
      const name = String(input.name || input.skill || input.id || '') || contentFallback;
      return { verb: '技能', detail: name || 'patent-*' };
    }
    if (tool === 'task' || tool === 'subtask') {
      const name = String(input.description || input.name || input.title || input.prompt || '') || contentFallback;
      return { verb: '已派子代理', detail: compactDetail(name).slice(0, 80) };
    }
    if (isQuestionToolName(tool)) {
      return summarizeQuestionTool(input, contentFallback);
    }
    if (tool === 'write' || tool === 'edit') {
      const target = fileLabel(String(input.path || input.filePath || input.file || '')) || contentFallback;
      return { verb: tool === 'write' ? '写入' : '编辑', detail: target || '文件' };
    }
    const web = summarizeWebTool(tool, input, contentFallback);
    if (web) return web;
    return {
      verb: tool,
      detail: compactDetail(String(
        input.url || input.path || input.filePath || input.pattern || input.query || input.command || input.name || ''
      ) || contentFallback)
    };
  }

  return null;
}

function thoughtText(step: AgentStep) {
  if (step.type === 'thought') return sanitizeThoughtDisplay(normalizeThoughtText(step.content));
  if (step.type === 'plan' || step.type === 'synthesis' || step.type === 'public_text') {
    return sanitizeThoughtDisplay(step.content);
  }
  return '';
}

function ThinkingStreamLine({
  step,
  active,
  allSteps,
  parentSessionId,
  progressItems,
  parentActive,
  onOpenTask,
  onReplyAsk
}: {
  step: AgentStep;
  active?: boolean;
  allSteps?: AgentStep[];
  parentSessionId?: string;
  progressItems?: ChatReproProgress[] | null;
  parentActive?: boolean;
  onOpenTask?: (key: string) => void;
  onReplyAsk?: (request: ChatAskRequest, answers: string[][]) => Promise<void>;
}) {
  if (isQuestionToolName(step.tool) && step.type === 'tool_call') {
    if (isPendingQuestionStep(step, allSteps || [step]) && onReplyAsk) return null;
    const summary = summarizeQuestionTool(step.input, step.content);
    return (
      <div className={`rag-oc-tool ${active ? 'rag-oc-tool-active' : ''}`} aria-busy={active || undefined}>
        <span className="rag-oc-tool-verb">{summary.verb}</span>
        {summary.detail ? <span className="rag-oc-tool-detail">{summary.detail}</span> : null}
      </div>
    );
  }
  if (isTaskToolName(step.tool) && step.type === 'tool_call' && onOpenTask) {
    const node = taskNodeFromStep(step, allSteps || [step], parentSessionId, progressItems, parentActive);
    return (
      <TaskSubagentButton
        step={step}
        node={node}
        active={active}
        onOpen={onOpenTask}
      />
    );
  }

  const prose = thoughtText(step);
  if (prose || (step.type === 'thought' && active)) {
    return (
      <div className={`rag-oc-prose ${active ? 'rag-oc-prose-active' : ''}`}>
        <div className="rag-oc-prose-body" aria-busy={active || undefined}>
          {prose || '正在思考…'}
        </div>
      </div>
    );
  }

  const summary = summarizeThinkStep(step);
  if (!summary) return null;
  return (
    <div className={`rag-oc-tool ${active ? 'rag-oc-tool-active' : ''}`} aria-busy={active || undefined}>
      <span className="rag-oc-tool-verb">{summary.verb}</span>
      {summary.detail ? (
        <span className={`rag-oc-tool-detail${summary.wrap ? ' rag-oc-tool-command' : ''}`}>
          {summary.detail}
        </span>
      ) : null}
    </div>
  );
}

function transcriptSteps(steps: AgentStep[]) {
  return visibleAgentSteps(steps)
    .filter((step) => step.type !== 'observation')
    .filter((step) => step.type === 'thought' || thoughtText(step) || summarizeThinkStep(step));
}

/** After the turn: keep the complete parent transcript, including final prose. */
function thinkingStepsAfterTurn(steps: AgentStep[]) {
  return steps.slice();
}

/** Live OpenCode-style timeline: text and tools in one stream, no think/answer split. */
function AgentLiveTranscript({
  steps,
  allSteps,
  parentSessionId,
  progressItems,
  status,
  onOpenTask,
  onReplyAsk
}: {
  steps: AgentStep[];
  allSteps?: AgentStep[];
  parentSessionId?: string;
  progressItems?: ChatReproProgress[] | null;
  status?: string;
  onOpenTask?: (key: string) => void;
  onReplyAsk?: (request: ChatAskRequest, answers: string[][]) => Promise<void>;
}) {
  const rendered = transcriptSteps(steps);
  const liveStatus = String(status || '').replace(/\s*ses_[A-Za-z0-9]+/g, '').replace(/能元会话/g, '').trim();
  return (
    <div className="rag-oc-live" aria-busy="true">
      <div className="rag-oc-stream">
        {rendered.length ? rendered.map((step, index) => (
          <ThinkingStreamLine
            key={`${step.step}-${step.type}-${index}`}
            step={step}
            active={index === rendered.length - 1}
            allSteps={allSteps}
            parentSessionId={parentSessionId}
            progressItems={progressItems}
            parentActive
            onOpenTask={onOpenTask}
            onReplyAsk={onReplyAsk}
          />
        )) : (
          <div className="rag-oc-prose rag-oc-prose-active">
            <div className="rag-oc-prose-body" aria-busy="true">
              {liveStatus || '正在分析…'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * After the turn completes: collapsed chain (everything before the final reply).
 * Split is done server-side as “text after the last tool” — same heuristic as OpenCode’s
 * final assistant message after tool rounds.
 */
function ThinkingBlock({
  steps,
  allSteps,
  parentSessionId,
  progressItems,
  running,
  onOpenTask,
  onReplyAsk
}: {
  steps: AgentStep[];
  allSteps?: AgentStep[];
  parentSessionId?: string;
  progressItems?: ChatReproProgress[] | null;
  running?: boolean;
  onOpenTask?: (key: string) => void;
  onReplyAsk?: (request: ChatAskRequest, answers: string[][]) => Promise<void>;
}) {
  const rendered = transcriptSteps(steps);
  const [expanded, setExpanded] = useState(false);

  if (!rendered.length) return null;

  return (
    <div className={`rag-think ${expanded ? 'rag-think-open' : ''}`}>
      <button
        type="button"
        className="rag-think-toggle"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={expanded ? '收起思考过程' : '展开思考过程'}
      >
        <span className="rag-think-label">思考过程</span>
        <ChevronDown className={`rag-think-chevron ${expanded ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      <RagThinkCollapse open={expanded}>
        <div className="rag-oc-stream rag-think-body">
          {rendered.map((step, index) => (
            <ThinkingStreamLine
              key={`${step.step}-${step.type}-${index}`}
              step={step}
              allSteps={allSteps}
              parentSessionId={parentSessionId}
              progressItems={progressItems}
              parentActive={Boolean(running)}
              onOpenTask={onOpenTask}
              onReplyAsk={onReplyAsk}
            />
          ))}
        </div>
      </RagThinkCollapse>
    </div>
  );
}

function AssistantAgentProcess({
  allSteps,
  live,
  running,
  progressItems,
  status,
  answerContent,
  sources,
  onCitationClick,
  onReplyAsk
}: {
  allSteps: AgentStep[];
  live?: boolean;
  running?: boolean;
  progressItems?: ChatReproProgress[] | null;
  status?: string;
  answerContent?: string;
  sources?: Source[];
  onCitationClick?: (id: string) => void;
  onReplyAsk?: (request: ChatAskRequest, answers: string[][]) => Promise<void>;
}) {
  const parentSessionId = inferParentSessionId(allSteps);
  const parentSteps = parentTranscriptSteps(allSteps, parentSessionId);
  const trailing = splitTrailingPublicAnswer(allSteps, parentSessionId);
  const settledAnswer = (answerContent || '').trim();
  const liveAnswer = settledAnswer || trailing.answer.trim();
  const chainSteps = (live || settledAnswer)
    ? parentTranscriptSteps(trailing.chain, parentSessionId)
    : thinkingStepsAfterTurn(parentSteps);
  const pendingAsks = pendingChatAskRequests(parentSteps);
  const nodes = collectVisibleChatAgentNodes(allSteps, parentSessionId, progressItems, {
    parentActive: Boolean(running)
  });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const openNode = nodes.find((node) => (node.parentToolCallId || node.nodeId) === openKey) || null;
  const childPanel = openNode
    ? childAgentPanelContent(allSteps, openNode, parentSessionId)
    : { timelineSteps: [], publicResult: '' };
  const openChildSteps = childPanel.timelineSteps;
  const openChildResult = childPanel.publicResult;
  const renderedChild = transcriptSteps(openChildSteps);

  const showLiveTranscript = !liveAnswer || transcriptSteps(chainSteps).length > 0;
  const process = live ? (
    <>
      {showLiveTranscript ? (
        <AgentLiveTranscript
          steps={chainSteps}
          allSteps={allSteps}
          parentSessionId={parentSessionId}
          progressItems={progressItems}
          status={status}
          onOpenTask={setOpenKey}
          onReplyAsk={onReplyAsk}
        />
      ) : null}
      {liveAnswer ? (
        <div className="mt-1 min-w-0">
          <MessageContent
            content={liveAnswer}
            streaming={!settledAnswer}
            sources={sources}
            onCitationClick={onCitationClick}
          />
        </div>
      ) : null}
    </>
  ) : (
    <ThinkingBlock
      steps={chainSteps}
      allSteps={allSteps}
      parentSessionId={parentSessionId}
      progressItems={progressItems}
      running={running}
      onOpenTask={setOpenKey}
      onReplyAsk={onReplyAsk}
    />
  );

  return (
    <>
      {process}
      {pendingAsks.length ? (
        <div className="mt-2 space-y-2">
          {pendingAsks.map((request) => (
            <ChatAskCard
              key={request.requestID || request.toolCallId || request.questions[0]?.question}
              request={request}
              disabled={!onReplyAsk}
              onSubmit={async (answers) => {
                if (!onReplyAsk) return;
                await onReplyAsk(request, answers);
              }}
            />
          ))}
        </div>
      ) : null}
      {openNode ? (
        <SubagentSessionPanel
          node={openNode}
          running={Boolean(running && openNode.status === 'running')}
          onClose={() => setOpenKey(null)}
          followKey={`${openChildSteps.length}:${String(openChildSteps.at(-1)?.content || '').length}:${openChildResult.length}`}
        >
          {renderedChild.length ? (
            <div className="rag-oc-stream">
              {renderedChild.map((step, index) => (
                <ThinkingStreamLine
                  key={`${step.step}-${step.type}-${index}`}
                  step={step}
                  active={Boolean(running && index === renderedChild.length - 1)}
                  allSteps={allSteps}
                  parentSessionId={parentSessionId}
                  progressItems={progressItems}
                  parentActive={Boolean(running)}
                  onOpenTask={setOpenKey}
                  onReplyAsk={onReplyAsk}
                />
              ))}
            </div>
          ) : null}
          {openChildResult ? (
            <section className="rag-oc-task-result" aria-label="子代理结果">
              <div className="rag-oc-task-result-label">子代理结果</div>
              <div className="rag-message-assistant rag-oc-task-result-body">
                <MessageContent content={openChildResult} enableMath />
              </div>
            </section>
          ) : null}
        </SubagentSessionPanel>
      ) : null}
    </>
  );
}

function formatTime(value: string) {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function mapConversation(item: Conversation): Conversation {
  return {
    ...item,
    kind: normalizeChatConversationKind(item.kind),
    skillIds: Array.isArray(item.skillIds) ? item.skillIds : [],
    generating: Boolean(item.generating),
    last_user_at: item.last_user_at || item.created_at
  };
}

function mergeConversationLists(local: Conversation[], remote: Conversation[]) {
  const localById = new Map(local.map((item) => [item.id, item]));
  const remoteIds = new Set(remote.map((item) => item.id));
  const merged = remote.map((item) => {
    const mapped = mapConversation(item);
    const prev = localById.get(item.id);
    if (!prev) return mapped;
    return {
      ...mapped,
      last_user_at: newerConversationTimestamp(prev.last_user_at, mapped.last_user_at)
    };
  });
  for (const item of local) {
    if (!remoteIds.has(item.id) && item.generating) merged.push(item);
  }
  return sortConversationsByLastUser(merged);
}

function normalizeChatConversationKind(value: unknown): ChatConversationKind {
  if (value === 'research-review' || value === RESEARCH_REVIEW_KIND) return 'research-review';
  return 'chat';
}

function attachmentApiBase(attachment: ChatAttachment, fallback: string) {
  return String(attachment.previewUrl || '').includes('/api/research-review')
    ? RESEARCH_REVIEW_API_BASE
    : fallback;
}

function uploadAttachmentRequest(
  file: File,
  conversationId: string,
  onProgress: (progress: number) => void,
  onProcessing: () => void,
  apiBase: string
) {
  return new Promise<{ conversationId: string; attachments: ChatAttachment[] }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('files', file, file.name);
    if (conversationId) formData.append('conversationId', conversationId);

    request.open('POST', `${apiBase}/attachments`);
    request.responseType = 'text';
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    });
    request.upload.addEventListener('load', onProcessing);
    request.addEventListener('load', () => {
      let payload: { conversationId?: string; attachments?: ChatAttachment[]; error?: string } = {};
      try {
        payload = JSON.parse(request.responseText || '{}') as typeof payload;
      } catch {
        reject(new Error(request.responseText.startsWith('<!DOCTYPE') ? '服务端返回了 HTML 错误页，请查看终端日志。' : '附件上传响应无效。'));
        return;
      }
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(payload.error || `附件上传失败（${request.status}）`));
        return;
      }
      if (!payload.conversationId || !Array.isArray(payload.attachments)) {
        reject(new Error('附件上传响应缺少必要信息。'));
        return;
      }
      resolve({ conversationId: payload.conversationId, attachments: payload.attachments });
    });
    request.addEventListener('error', () => reject(new Error('附件上传网络请求失败。')));
    request.addEventListener('abort', () => reject(new Error('附件上传已取消。')));
    request.send(formData);
  });
}

export function ChatWorkbench({ config = DEFAULT_CHAT_WORKBENCH }: { config?: ChatWorkbenchConfig } = {}) {
  const allowAnyAttachments = !config.allowedExtensions;
  const allowedAttachmentExtensions = useMemo(
    () => new Set(config.allowedExtensions || [...ALLOWED_ATTACHMENT_EXTENSIONS]),
    [config.allowedExtensions]
  );
  const attachmentAccept = allowAnyAttachments ? undefined : (config.attachmentAccept || ATTACHMENT_ACCEPT);
  const attachmentHint = config.attachmentHint || (allowAnyAttachments ? CHAT_ATTACHMENT_HINT : ATTACHMENT_FORMAT_HINT);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { loading: statsLoading } = useDashboardStats();
  const { user, loading: authLoading } = useAuth();
  const authUserIdRef = useRef(user?.id || '');
  const incomingQuestion = searchParams.get('question') || '';
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [question, setQuestion] = useState(incomingQuestion);
  const questionRef = useRef(incomingQuestion);
  const composerReadyRef = useRef(false);
  const composerHydratingRef = useRef(false);
  const composerDraftLoadSeqRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [sendQueue, setSendQueue] = useState<ChatQueuedTurn[]>([]);
  const [listReady, setListReady] = useState(false);
  const [listEntering, setListEntering] = useState(false);
  const [, setError] = useNotifyError();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  usePageContentReady(listReady);
  const [conversationId, setConversationId] = useState('');
  const [powerOpen, setPowerOpen] = useState(false);
  useEffect(()=>{if(new URL(window.location.href).searchParams.has('powerRun'))setPowerOpen(true);},[]);
  const [conversationTitle, setConversationTitle] = useState('新会话');
  const bottomRef = useRef<HTMLDivElement>(null);
  const [subagentSheetHost, setSubagentSheetHost] = useState<HTMLElement | null>(null);
  const lastIncomingQuestionRef = useRef('');
  const controllerRef = useRef<AbortController | null>(null);
  const liveRunsRef = useRef(new Map<string, {
    controller: AbortController;
    userMessageId: string;
    assistantMessageId: string;
  }>());
  const requestSeqRef = useRef(0);
  const conversationLoadSeqRef = useRef(0);
  const conversationLoadTargetRef = useRef('');
  const messagesRef = useRef<ChatMessage[]>(initialMessages);
  const loadingRef = useRef(false);
  const generatingIdsRef = useRef<Set<string>>(new Set());
  const sendQueueRef = useRef<ChatQueuedTurn[]>([]);
  const sendQueueLoadSeqRef = useRef(0);
  const conversationListLoadSeqRef = useRef(0);
  const drainSendQueueRef = useRef<(conversationId: string) => void>(() => undefined);
  const drainInFlightRef = useRef('');
  const resumePollSeqRef = useRef(0);
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(() => new Set());
  const [unreadCompletedIds, setUnreadCompletedIds] = useState<Set<string>>(() => new Set());
  const [streamingMessageId, setStreamingMessageId] = useState('');
  const [modalSource, setModalSource] = useState<Source | null>(null);
  const [modalAttachment, setModalAttachment] = useState<ChatAttachment | null>(null);
  const [knowledgeGraphOpen, setKnowledgeGraphOpen] = useState(false);
  const [reasoningRatio, setReasoningRatio] = useState(defaultChatThinkingRatio(DEFAULT_CHAT_MODEL));
  const [chatModel, setChatModel] = useState<ChatModelId>(DEFAULT_CHAT_MODEL);
  const [thinkingCatalogs, setThinkingCatalogs] = useState<Record<ChatModelId, ThinkingLevel[]>>({
    arc: fallbackThinkingLevels('arc'),
    thunder: fallbackThinkingLevels('thunder'),
    storm: fallbackThinkingLevels('storm')
  });
  const pickerModel: ChatModelId = config.fixedModelRole
    ? chatModelFromEndpointRole(config.fixedModelRole)
    : chatModel;
  const thinkingLevels = thinkingCatalogs[pickerModel] || fallbackThinkingLevels(pickerModel);
  const reasoningTier = useMemo(
    () => resolveChatReasoningTier(reasoningRatio, thinkingLevels),
    [reasoningRatio, thinkingLevels]
  );
  const [statusDetail, setStatusDetail] = useState('');
  const previewSubagent = searchParams.get('preview') === 'subagent';
  const [reproProgressState, setReproProgressState] = useState<{
    conversationId: string;
    items: ChatReproProgress[];
  }>({ conversationId: '', items: [] });
  const reproProgressItems = reproProgressState.conversationId === conversationId
    ? reproProgressState.items
    : [];
  const composerToolsEnabled = true;
  const incomingTool = composerToolsEnabled ? composerToolFromSearch(searchParams.get('tool')) : null;
  const [composerTool, setComposerTool] = useState<ComposerToolId | null>(
    () => incomingTool
  );
  const [conversationKind, setConversationKind] = useState<ChatConversationKind>(
    conversationKindForTool(incomingTool) === 'research-review'
      ? 'research-review'
      : (config.conversationKind || 'chat')
  );
  const composerToolRef = useRef<ComposerToolId | null>(incomingTool);
  const conversationKindRef = useRef<ChatConversationKind>(
    conversationKindForTool(incomingTool) === 'research-review'
      ? 'research-review'
      : (config.conversationKind || 'chat')
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [convSearch, setConvSearch] = useState('');
  const [chatPanelWidth, setChatPanelWidth] = useState(DEFAULT_CHAT_PANEL_WIDTH);
  const [resizingChatPanel, setResizingChatPanel] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [pendingManagerOpen, setPendingManagerOpen] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [sidePluginOpen, setSidePluginOpen] = useState(false);
  const [sidePluginId, setSidePluginId] = useState(ATTACHMENT_SIDE_PLUGIN_ID);
  const [welcomeLine, setWelcomeLine] = useState(
    () => welcomePromptsForTool(incomingTool, config.welcomePrompts)[0] || WELCOME_PROMPTS[0]
  );
  const [welcomeKey, setWelcomeKey] = useState(0);
  const [historyEditing, setHistoryEditing] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  const [composerLineCount, setComposerLineCount] = useState(1);
  const conversationIdRef = useRef('');
  const conversationTitleRef = useRef('新会话');
  const conversationStartedRef = useRef(false);
  const titleRequestIdRef = useRef('');
  const resumePollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredSessionRef = useRef(false);
  const listIntroPlayedRef = useRef(false);
  const mountedRef = useRef(true);
  const liveConnectedRef = useRef(false);
  const liveReconcileSeqRef = useRef(0);
  const reconcileLiveConnectionRef = useRef<() => void>(() => undefined);
  const handleLiveEventRef = useRef<(event: ChatLiveEvent) => void>(() => undefined);
  const remoteSyncRef = useRef<RemoteSyncState | null>(null);
  const skipCompletedNoticeRef = useRef(new Set<string>());
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const cancelledUploadIdsRef = useRef(new Set<string>());
  const dragDepthRef = useRef(0);
  const addAttachmentFilesRef = useRef<(files: FileList | File[]) => void>(() => undefined);

  useEffect(() => {
    if (authLoading) return;
    const nextUserId = user?.id || '';
    const previousUserId = authUserIdRef.current;
    if (previousUserId && previousUserId !== nextUserId) {
      conversationLoadSeqRef.current += 1;
      conversationLoadTargetRef.current = '';
      conversationListLoadSeqRef.current += 1;
      sendQueueLoadSeqRef.current += 1;
      liveReconcileSeqRef.current += 1;
      composerDraftLoadSeqRef.current += 1;
      persistCurrentComposerDraft();
      stopResumePoll();
      controllerRef.current?.abort();
      for (const run of liveRunsRef.current.values()) run.controller.abort();
      liveRunsRef.current.clear();
      controllerRef.current = null;
      remoteSyncRef.current = null;
      composerReadyRef.current = false;
      composerHydratingRef.current = false;
      restoredSessionRef.current = false;
      conversationIdRef.current = '';
      conversationTitleRef.current = '新会话';
      titleRequestIdRef.current = '';
      messagesRef.current = initialMessages;
      pendingAttachmentsRef.current = [];
      setConversationId('');
      setConversationTitle('新会话');
      setConversations([]);
      setListReady(false);
      listIntroPlayedRef.current = false;
      setMessages(initialMessages);
      setPendingAttachments([]);
      setQuestion(incomingQuestion);
      questionRef.current = incomingQuestion;
      setLoading(false);
      loadingRef.current = false;
      setStreamingMessageId('');
      setModalSource(null);
      setModalAttachment(null);
      setKnowledgeGraphOpen(false);
      setPendingManagerOpen(false);
      setSidePluginOpen(false);
      setHistoryOpen(false);
      setHistoryEditing(false);
      setReproProgressState({ conversationId: '', items: [] });
      setGeneratingIds(new Set());
      generatingIdsRef.current = new Set();
      setUnreadCompletedIds(new Set());
      cancelledUploadIdsRef.current.clear();
      uploadQueueRef.current = Promise.resolve();
      if (nextUserId) {
        writeActiveConversation(config.panelStorageKey, nextUserId, null);
      }
    }
    authUserIdRef.current = nextUserId;
  }, [authLoading, incomingQuestion, user?.id]);

  function clampChatPanelWidth(width: number) {
    const normalizedWidth = Math.min(MAX_CHAT_PANEL_WIDTH, Math.max(MIN_CHAT_PANEL_WIDTH, width));
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1280px)').matches) {
      return Math.round(normalizedWidth);
    }
    const shellWidth = layoutRef.current?.getBoundingClientRect().width || 0;
    const availableMax = shellWidth > 0
      ? shellWidth - MIN_WORKSPACE_WIDTH - 10
      : MAX_CHAT_PANEL_WIDTH;
    return Math.round(Math.max(MIN_CHAT_PANEL_WIDTH, Math.min(normalizedWidth, availableMax)));
  }

  useEffect(() => {
    const storedWidth = Number(window.localStorage.getItem(config.panelStorageKey));
    if (Number.isFinite(storedWidth) && storedWidth > 0) {
      setChatPanelWidth(clampChatPanelWidth(storedWidth));
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(config.panelStorageKey, String(chatPanelWidth));
  }, [chatPanelWidth, config.panelStorageKey]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    conversationTitleRef.current = conversationTitle;
  }, [conversationTitle]);

  useEffect(() => {
    questionRef.current = question;
  }, [question]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    generatingIdsRef.current = generatingIds;
  }, [generatingIds]);

  useEffect(() => {
    if (authLoading || !user?.id) return;
    let cancelled = false;
    sendQueueRef.current = [];
    setSendQueue([]);
    void refreshSendQueue({ drain: true })
      .catch((error) => {
        if (!cancelled) setError(error instanceof Error ? error.message : '加载排队失败');
      });
    return () => {
      cancelled = true;
      sendQueueLoadSeqRef.current += 1;
    };
  }, [authLoading, user?.id]);

  useEffect(() => {
    if (!conversationId || !user?.id) return;
    if (authUserIdRef.current !== user.id || conversationIdRef.current !== conversationId) return;
    writeActiveConversation(config.panelStorageKey, user.id, {
      conversationId,
      kind: conversationKind
    });
  }, [config.panelStorageKey, conversationId, conversationKind, user?.id]);

  useEffect(() => {
    if (!conversationId) {
      setReproProgressState({ conversationId: '', items: [] });
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/repro-progress`);
        if (!response.ok) return;
        const payload = await response.json() as { items?: ChatReproProgress[] };
        if (!cancelled && Array.isArray(payload.items)) {
          setReproProgressState({ conversationId, items: payload.items });
        }
      } catch {
        /* progress file is optional */
      }
    };
    void load();
    if (!loading) return () => { cancelled = true; };
    const timer = window.setInterval(() => { void load(); }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [conversationId, loading]);

  function stopResumePoll() {
    resumePollSeqRef.current += 1;
    if (resumePollRef.current) {
      clearTimeout(resumePollRef.current);
      resumePollRef.current = null;
    }
  }

  function requestStopGeneration(id?: string) {
    const conversation = id || conversationIdRef.current;
    if (!conversation) return;
    void fetch(`/api/chat/conversations/${encodeURIComponent(conversation)}/stop`, { method: 'POST' })
      .catch(() => undefined);
  }

  function hasLocalRun(id: string) {
    if (!id) return false;
    const live = liveRunsRef.current.get(id);
    if (live && !live.controller.signal.aborted) return true;
    return Boolean(
      controllerRef.current
      && conversationIdRef.current === id
      && !controllerRef.current.signal.aborted
    );
  }

  function isLocalOriginator(event: ChatLiveEvent) {
    if (!event.conversationId) return false;
    const live = liveRunsRef.current.get(event.conversationId);
    if (!live || live.controller.signal.aborted) return false;
    return isChatLiveEventFromRun(event, {
      conversationId: event.conversationId,
      userMessageId: live.userMessageId,
      assistantMessageId: live.assistantMessageId
    });
  }

  function markConversationGenerating(id: string, generating: boolean) {
    if (!id) return;
    if (generating) skipCompletedNoticeRef.current.delete(id);
    const has = generatingIdsRef.current.has(id);
    if (generating === has) return;
    const next = new Set(generatingIdsRef.current);
    if (generating) next.add(id);
    else next.delete(id);
    generatingIdsRef.current = next;
    setGeneratingIds(next);
  }

  function markConversationUnread(id: string) {
    if (!id || !authUserIdRef.current) return;
    const next = new Set(readUnreadCompletedConversations(authUserIdRef.current));
    if (next.has(id)) {
      if (mountedRef.current && !unreadCompletedIds.has(id)) setUnreadCompletedIds(next);
      return;
    }
    next.add(id);
    writeUnreadCompletedConversations(authUserIdRef.current, [...next]);
    if (mountedRef.current) setUnreadCompletedIds(next);
  }

  function clearConversationUnread(id: string) {
    if (!id || !authUserIdRef.current) return;
    const current = readUnreadCompletedConversations(authUserIdRef.current);
    if (!current.includes(id)) {
      if (mountedRef.current && unreadCompletedIds.has(id)) {
        setUnreadCompletedIds(new Set(current));
      }
      return;
    }
    const next = current.filter((item) => item !== id);
    writeUnreadCompletedConversations(authUserIdRef.current, next);
    if (mountedRef.current) setUnreadCompletedIds(new Set(next));
  }

  function isConversationUiFocused(id: string) {
    if (!id || !mountedRef.current) return false;
    if (conversationIdRef.current !== id) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    return true;
  }

  function noteGenerationSettled(id: string) {
    if (!id) return;
    if (skipCompletedNoticeRef.current.has(id)) return;
    if (isConversationUiFocused(id)) {
      clearConversationUnread(id);
      return;
    }
    markConversationUnread(id);
  }

  function promoteConversationByUserMessage(id: string, title?: string) {
    if (!id) return;
    const now = new Date().toISOString();
    setConversations((current) => {
      const exists = current.some((item) => item.id === id);
      const next = exists
        ? current.map((item) =>
          item.id === id
            ? {
                ...item,
                last_user_at: now,
                generating: true
              }
            : item
        )
        : [
            {
              id,
              title: title || conversationTitleRef.current || '新会话',
              created_at: now,
              updated_at: now,
              last_user_at: now,
              messageCount: 1,
              kind: conversationKindRef.current,
              generating: true
            },
            ...current
          ];
      return sortConversationsByLastUser(next);
    });
  }

  /** Leave the current view without stopping the OpenCode run. */
  function detachInFlight() {
    stopResumePoll();
    const previousId = conversationIdRef.current;
    if (previousId && (loading || controllerRef.current || liveRunsRef.current.has(previousId))) {
      markConversationGenerating(previousId, true);
    }
    controllerRef.current = null;
    setLoading(false);
    loadingRef.current = false;
    setStreamingMessageId('');
    setStatusDetail('');
    if (previousId) void loadConversations({ bypassCache: true });
  }

  useEffect(() => {
    composerToolRef.current = composerTool;
  }, [composerTool]);

  useEffect(() => {
    conversationKindRef.current = conversationKind;
  }, [conversationKind]);

  function syncComposerToolUrl(tool: ComposerToolId | null) {
    const params = new URLSearchParams(searchParams.toString());
    const current = composerToolFromSearch(params.get('tool'));
    if (current === tool) return;
    if (tool) params.set('tool', tool);
    else params.delete('tool');
    const qs = params.toString();
    const path = pathname || '/chat';
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
  }

  useEffect(() => {
    if (!composerToolsEnabled) return;
    const nextTool = composerToolFromSearch(searchParams.get('tool'));
    if (!nextTool || nextTool === composerToolRef.current) return;
    composerToolRef.current = nextTool;
    const nextKind = conversationKindForTool(nextTool);
    conversationKindRef.current = nextKind;
    setComposerTool(nextTool);
    setConversationKind(nextKind);
  }, [composerToolsEnabled, searchParams]);

  function apiBaseForKind(kind?: ChatConversationKind | null) {
    if (kind === 'research-review') return RESEARCH_REVIEW_API_BASE;
    if (kind === 'chat') return '/api/chat';
    return config.apiBase;
  }

  function persistConversationChatModel(next: ChatModelId) {
    const id = conversationIdRef.current;
    if (!id || conversationStartedRef.current) return;
    void fetch(`${apiBaseForKind(conversationKindRef.current)}/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatModel: next })
    }).catch(() => undefined);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/system/thinking-levels', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('thinking probe failed');
        return response.json() as Promise<Record<ChatModelId, { levels?: ThinkingLevel[] }>>;
      })
      .then((payload) => {
        setThinkingCatalogs((current) => {
          const next = { ...current };
          for (const id of CHAT_MODEL_IDS) {
            const levels = payload[id]?.levels;
            if (Array.isArray(levels) && levels.length) next[id] = levels;
          }
          return next;
        });
      })
      .catch((error) => {
        if ((error as Error).name === 'AbortError') return;
      });
    return () => controller.abort();
  }, []);

  function outgoingComposerKind(): ChatConversationKind {
    if (composerToolRef.current === 'research-review') return 'research-review';
    return 'chat';
  }

  function beginChatPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.focus();
    resizeStartRef.current = { x: event.clientX, width: chatPanelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingChatPanel(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function resizeChatPanel(event: ReactPointerEvent<HTMLDivElement>) {
    const start = resizeStartRef.current;
    if (!start) return;
    setChatPanelWidth(clampChatPanelWidth(start.width + start.x - event.clientX));
  }

  function finishChatPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizingChatPanel(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  function handleResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 24;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setChatPanelWidth((current) => clampChatPanelWidth(current + step));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setChatPanelWidth((current) => clampChatPanelWidth(current - step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setChatPanelWidth(MIN_CHAT_PANEL_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      setChatPanelWidth(clampChatPanelWidth(MAX_CHAT_PANEL_WIDTH));
    }
  }

  function setPendingAttachmentState(
    updater: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[])
  ) {
    setPendingAttachments((current) => {
      const next = typeof updater === 'function' ? updater(current) : updater;
      pendingAttachmentsRef.current = next;
      return next;
    });
  }

  function currentComposerDraftKey() {
    return composerDraftKey(config.panelStorageKey, authUserIdRef.current);
  }

  function persistCurrentComposerDraft() {
    if (!authUserIdRef.current || !composerReadyRef.current || composerHydratingRef.current) return;
    const files = pendingAttachmentsRef.current
      .filter((item) => item.status !== 'removing')
      .map((item) => ({
        clientId: item.clientId,
        name: item.name,
        type: item.mediaType,
        lastModified: item.file.lastModified,
        blob: item.file,
        attachment: item.attachment ? toDraftAttachment(item.attachment) : undefined,
        attachments: item.attachments?.map(toDraftAttachment)
      }));
    writeComposerDraft(currentComposerDraftKey(), {
      question: questionRef.current,
      composerTool: composerToolRef.current,
      files
    });
  }

  function applyComposerDraft(draft: {
    question: string;
    composerTool: ComposerToolId | null;
    files: Array<{
      clientId: string;
      name: string;
      type: string;
      lastModified: number;
      blob: Blob;
      attachment?: ComposerDraftAttachment;
      attachments?: ComposerDraftAttachment[];
    }>;
  } | null) {
    if (!draft) return;
    setQuestion(draft.question);
    questionRef.current = draft.question;
    if (composerToolsEnabled) {
      composerToolRef.current = draft.composerTool;
      setComposerTool(draft.composerTool);
      syncComposerToolUrl(draft.composerTool);
      if (!conversationIdRef.current) {
        const nextKind = conversationKindForTool(draft.composerTool);
        conversationKindRef.current = nextKind;
        setConversationKind(nextKind);
      }
    }
    const restored = draft.files.map((file) => {
      const restoredFile = fileFromDraftBlob(file);
      const attachments = (file.attachments || (file.attachment ? [file.attachment] : []))
        .map(fromDraftAttachment);
      return {
        clientId: file.clientId,
        file: restoredFile,
        name: file.name,
        extension: attachmentExtension(file.name),
        mediaType: file.type || restoredFile.type || 'application/octet-stream',
        size: restoredFile.size,
        status: 'ready' as const,
        progress: 100,
        attachments: attachments.length ? attachments : undefined,
        attachment: attachments[0]
      } satisfies PendingAttachment;
    });
    setPendingAttachmentState(restored);
  }

  async function restoreComposerDraft() {
    const userId = authUserIdRef.current;
    const loadSeq = ++composerDraftLoadSeqRef.current;
    const draftKey = composerDraftKey(config.panelStorageKey, userId);
    composerHydratingRef.current = true;
    try {
      const draft = await readComposerDraft(draftKey);
      if (loadSeq !== composerDraftLoadSeqRef.current || userId !== authUserIdRef.current) return;
      if (draft) {
        const urlTool = composerToolFromSearch(searchParams.get('tool'));
        applyComposerDraft(urlTool ? { ...draft, composerTool: draft.composerTool || urlTool } : draft);
      }
      composerReadyRef.current = true;
    } finally {
      if (loadSeq === composerDraftLoadSeqRef.current) {
        composerHydratingRef.current = false;
      }
    }
  }

  function keepLocalPendingFiles() {
    const pending = pendingAttachmentsRef.current;
    const uploaded = pending.flatMap((item) =>
      pendingAttachmentRecords(item).filter((attachment) => !attachment.deduplicated)
    );
    setPendingAttachmentState((current) => current.map((item) => ({
      ...item,
      status: item.status === 'failed' ? 'failed' : 'ready',
      progress: item.status === 'failed' ? item.progress : 100,
      attachments: undefined,
      attachment: undefined
    })));
    if (!uploaded.length) return;
    void Promise.all(uploaded.map((attachment) => deletePendingAttachmentFromServer(attachment)))
      .catch((error) => setError(error instanceof Error ? error.message : '部分待发送附件清理失败。'));
  }

  function updatePendingAttachment(
    clientId: string,
    updater: (attachment: PendingAttachment) => PendingAttachment
  ) {
    setPendingAttachmentState((current) =>
      current.map((attachment) => attachment.clientId === clientId ? updater(attachment) : attachment)
    );
  }

  async function deletePendingAttachmentFromServer(attachment: ChatAttachment) {
    const params = new URLSearchParams({
      conversationId: attachment.conversationId,
      attachmentId: attachment.id
    });
    const response = await fetch(`${attachmentApiBase(attachment, config.apiBase)}/attachments?${params.toString()}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({})) as { error?: string; conversationDeleted?: boolean };
    if (!response.ok && response.status !== 404) {
      throw new Error(payload.error || '附件删除失败。');
    }
    if (payload.conversationDeleted && conversationIdRef.current === attachment.conversationId) {
      conversationIdRef.current = '';
      setConversationId('');
      setConversationTitle('新会话');
      void loadConversations({ bypassCache: true });
    }
  }

  async function uploadPendingAttachment(pending: PendingAttachment, userId: string) {
    if (userId !== authUserIdRef.current) return;
    const updateForUser = (updater: (attachment: PendingAttachment) => PendingAttachment) => {
      if (userId === authUserIdRef.current) updatePendingAttachment(pending.clientId, updater);
    };
    if (cancelledUploadIdsRef.current.has(pending.clientId)) {
      cancelledUploadIdsRef.current.delete(pending.clientId);
      return;
    }

    try {
      const outgoingKind = outgoingComposerKind();
      const boundConversationId = conversationKindRef.current === outgoingKind
        ? conversationIdRef.current
        : '';
      if (!boundConversationId) {
        updateForUser((current) => ({
          ...current,
          status: 'ready',
          progress: 100,
          error: undefined
        }));
        return;
      }
      updateForUser((current) => ({
        ...current,
        status: 'uploading',
        progress: 0,
        error: undefined
      }));
      const result = await uploadAttachmentRequest(
        pending.file,
        boundConversationId,
        (progress) => updateForUser((current) => ({ ...current, progress })),
        () => updateForUser((current) => ({
          ...current,
          status: 'processing',
          progress: 100
        })),
        apiBaseForKind(outgoingKind)
      );
      if (userId !== authUserIdRef.current) return;
      const uploaded = result.attachments;
      if (!uploaded.length) throw new Error('服务端未返回已上传的附件。');

      if (cancelledUploadIdsRef.current.has(pending.clientId)) {
        await Promise.all(uploaded.map((attachment) => deletePendingAttachmentFromServer(attachment))).catch(() => undefined);
        cancelledUploadIdsRef.current.delete(pending.clientId);
        return;
      }

      const failed = uploaded.find((attachment) => attachment.status !== 'ready');
      if (failed) {
        await Promise.all(uploaded.map((attachment) => deletePendingAttachmentFromServer(attachment))).catch(() => undefined);
        throw new Error(failed.error || '附件解析失败。');
      }

      updateForUser((current) => ({
        ...current,
        status: 'ready',
        progress: 100,
        attachments: uploaded,
        attachment: uploaded[0]
      }));
    } catch (error) {
      if (userId !== authUserIdRef.current) return;
      if (cancelledUploadIdsRef.current.has(pending.clientId)) {
        cancelledUploadIdsRef.current.delete(pending.clientId);
        return;
      }
      const message = error instanceof Error ? error.message : '附件上传失败。';
      updateForUser((current) => ({
        ...current,
        status: 'failed',
        error: message
      }));
      setError(`${pending.name}：${message}`);
    }
  }

  async function flushPendingUploads(conversationId: string, apiBase: string, userId: string) {
    const uploaded: ChatAttachment[] = [];
    for (const pending of pendingAttachmentsRef.current) {
      if (userId !== authUserIdRef.current) return uploaded;
      if (pending.status !== 'ready') continue;
      const bound = pendingAttachmentRecords(pending).filter((item) => item.conversationId === conversationId);
      if (bound.length) {
        uploaded.push(...bound);
        continue;
      }
      const result = await uploadAttachmentRequest(
        pending.file,
        conversationId,
        (progress) => {
          if (userId !== authUserIdRef.current) return;
          updatePendingAttachment(pending.clientId, (current) => ({
            ...current,
            status: 'uploading',
            progress,
            error: undefined
          }));
        },
        () => {
          if (userId !== authUserIdRef.current) return;
          updatePendingAttachment(pending.clientId, (current) => ({
            ...current,
            status: 'processing',
            progress: 100
          }));
        },
        apiBase
      );
      if (userId !== authUserIdRef.current) return uploaded;
      if (!result.attachments.length) throw new Error(`${pending.name}：服务端未返回已上传的附件。`);
      const failed = result.attachments.find((attachment) => attachment.status !== 'ready');
      if (failed) throw new Error(failed.error || `${pending.name}：附件解析失败。`);
      updatePendingAttachment(pending.clientId, (current) => ({
        ...current,
        status: 'ready',
        progress: 100,
        attachments: result.attachments,
        attachment: result.attachments[0]
      }));
      uploaded.push(...result.attachments);
    }
    return uploaded;
  }

  function addAttachmentFiles(fileList: FileList | File[]) {
    if (loading) {
      setError('请等待当前回答完成后再添加附件。');
      return;
    }

    const files = Array.from(fileList).map((file) => normalizeClipboardFile(file));
    if (!files.length) return;
    const current = pendingAttachmentsRef.current;
    const availableSlots = Math.max(0, MAX_ATTACHMENT_FILES - current.length);
    const existingKeys = new Set(current.map((attachment) =>
      `${attachment.name.toLowerCase()}:${attachment.size}:${attachment.file.lastModified}`
    ));
    const accepted: PendingAttachment[] = [];
    const validationErrors: string[] = [];

    for (const file of files) {
      const extension = attachmentExtension(file.name);
      const key = `${file.name.toLowerCase()}:${file.size}:${file.lastModified}`;
      if (!allowAnyAttachments && !allowedAttachmentExtensions.has(extension)) {
        validationErrors.push(`${file.name}：不支持此文件类型`);
        continue;
      }
      if (!file.size) {
        validationErrors.push(`${file.name}：不能上传空文件`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        validationErrors.push(`${file.name}：超过 200 MB`);
        continue;
      }
      if (existingKeys.has(key)) {
        validationErrors.push(`${file.name}：已添加`);
        continue;
      }
      if (accepted.length >= availableSlots) {
        validationErrors.push(`每条消息最多添加 ${MAX_ATTACHMENT_FILES} 个附件`);
        break;
      }
      existingKeys.add(key);
      const boundConversation = Boolean(conversationIdRef.current)
        && conversationKindRef.current === outgoingComposerKind();
      accepted.push({
        clientId: createId(),
        file,
        name: file.name,
        extension,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
        status: boundConversation ? 'queued' : 'ready',
        progress: boundConversation ? 0 : 100
      });
    }

    if (validationErrors.length) setError([...new Set(validationErrors)].join('；'));
    else setError('');
    if (!accepted.length) return;

    setPendingAttachmentState((attachments) => [...attachments, ...accepted]);
    if (!conversationIdRef.current || conversationKindRef.current !== outgoingComposerKind()) return;
    const userId = authUserIdRef.current;
    for (const pending of accepted) {
      const task = uploadQueueRef.current
        .catch(() => undefined)
        .then(() => uploadPendingAttachment(pending, userId));
      uploadQueueRef.current = task;
    }
  }

  addAttachmentFilesRef.current = addAttachmentFiles;

  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (composerToolRef.current === 'patent') return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const field = target.closest('input, textarea, select, [contenteditable="true"]');
        if (field && field !== questionInputRef.current && field !== fileInputRef.current) return;
      }
      const files = filesFromClipboard(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      addAttachmentFilesRef.current(files);
    }
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, []);

  function removePendingAttachment(clientId: string) {
    const pending = pendingAttachmentsRef.current.find((attachment) => attachment.clientId === clientId);
    if (!pending || pending.status === 'removing') return;
    cancelledUploadIdsRef.current.add(clientId);

    const records = pendingAttachmentRecords(pending);
    if (!records.length) {
      setPendingAttachmentState((current) => current.filter((attachment) => attachment.clientId !== clientId));
      return;
    }
    const deletable = records.filter((attachment) => !attachment.deduplicated);
    if (!deletable.length) {
      cancelledUploadIdsRef.current.delete(clientId);
      setPendingAttachmentState((current) => current.filter((attachment) => attachment.clientId !== clientId));
      return;
    }

    updatePendingAttachment(clientId, (current) => ({ ...current, status: 'removing', error: undefined }));
    void Promise.all(deletable.map((attachment) => deletePendingAttachmentFromServer(attachment)))
      .then(() => {
        cancelledUploadIdsRef.current.delete(clientId);
        setPendingAttachmentState((current) => current.filter((attachment) => attachment.clientId !== clientId));
      })
      .catch((error) => {
        cancelledUploadIdsRef.current.delete(clientId);
        const message = error instanceof Error ? error.message : '附件删除失败。';
        updatePendingAttachment(clientId, (current) => ({ ...current, status: 'failed', error: message }));
        setError(message);
      });
  }

  function discardPendingAttachments() {
    const pending = pendingAttachmentsRef.current;
    if (!pending.length) return;
    for (const attachment of pending) cancelledUploadIdsRef.current.add(attachment.clientId);
    setPendingAttachmentState([]);
    const uploaded = pending.flatMap((attachment) =>
      pendingAttachmentRecords(attachment).filter((item) => !item.deduplicated)
    );
    if (uploaded.length) {
      void Promise.all(uploaded.map((attachment) => deletePendingAttachmentFromServer(attachment)))
        .catch((error) => setError(error instanceof Error ? error.message : '部分待发送附件删除失败。'));
    }
  }

  function isFileDrag(event: ReactDragEvent<HTMLDivElement>) {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function handleFileDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDraggingFiles(true);
  }

  function handleFileDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleFileDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (!dragDepthRef.current) setDraggingFiles(false);
  }

  function handleFileDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDraggingFiles(false);
    addAttachmentFiles(event.dataTransfer.files);
  }

  const conversationGraphSeedIds = useMemo(
    () => [...new Set(messages.flatMap((message) => message.graphSeedIds || []).filter(Boolean))],
    [messages]
  );

  const sourcesById = useMemo(() => {
    const map = new Map<string, Source>();
    const register = (source: Source) => {
      if (source.id) map.set(source.id, source);
      for (const evidenceId of source.evidenceIds || []) map.set(evidenceId, source);
    };
    for (const message of messages) {
      const list = message.role === 'assistant'
        ? assistantMessageSources(message)
        : (message.sources || []);
      for (const source of list) register(source);
    }
    return map;
  }, [messages]);

  const knowledgeSources = useMemo(() => {
    const map = new Map<string, Source>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const source of assistantMessageSources(message)) {
        const key = source.id || source.sourceKey || source.title;
        if (!map.has(key)) map.set(key, source);
      }
    }
    return [...map.values()];
  }, [messages]);

  function openCitation(id: string) {
    const resolve = () => {
      const direct = sourcesById.get(id);
      if (direct) return direct;
      for (const message of messages) {
        const matched = findSourceByCitationId(message.sources || [], id);
        if (matched) return matched;
      }
      return null;
    };
    const matched = resolve();
    if (!matched) return;
    if (isLinkSource(matched)) {
      const url = linkSourceUrl(matched);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    setModalSource(matched);
  }

  useEffect(() => {
    if (authLoading) return;
    if (!user?.id) {
      conversationListLoadSeqRef.current += 1;
      setConversations([]);
      setListReady(true);
      return;
    }
    setListReady(false);
    void loadConversations();
  }, [authLoading, user?.id]);

  useEffect(() => {
    mountedRef.current = true;
    if (!authLoading && user?.id) {
      setUnreadCompletedIds(new Set(readUnreadCompletedConversations(user.id)));
    }
    return () => {
      mountedRef.current = false;
    };
  }, [authLoading, user?.id]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) return;
      const id = conversationIdRef.current;
      if (!id) return;
      const current = readUnreadCompletedConversations(authUserIdRef.current);
      if (!current.includes(id)) return;
      const next = current.filter((item) => item !== id);
      writeUnreadCompletedConversations(authUserIdRef.current, next);
      setUnreadCompletedIds(new Set(next));
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    const interval = generatingIds.size > 0 ? 2_500 : 8_000;
    const timer = window.setInterval(() => {
      void loadConversations({ bypassCache: true });
    }, interval);
    return () => window.clearInterval(timer);
  }, [generatingIds.size]);

  useEffect(() => {
    if (authLoading || !user?.id) {
      liveConnectedRef.current = false;
      return;
    }
    const connectedUserId = user.id;
    const abort = new AbortController();
    void consumeChatLive({
      signal: abort.signal,
      onConnected: () => {
        liveConnectedRef.current = true;
        reconcileLiveConnectionRef.current();
      },
      onDisconnected: () => {
        liveConnectedRef.current = false;
        liveReconcileSeqRef.current += 1;
      },
      onEvent: (event) => {
        if (event.userId !== connectedUserId || authUserIdRef.current !== connectedUserId) return;
        handleLiveEventRef.current(event);
      }
    });
    return () => {
      liveConnectedRef.current = false;
      abort.abort();
    };
  }, [authLoading, user?.id]);

  async function reconcileLiveConnection() {
    if (!authUserIdRef.current) return;
    const reconcileSeq = ++liveReconcileSeqRef.current;
    await Promise.allSettled([
      loadConversations({ bypassCache: true }),
      refreshSendQueue({ drain: false })
    ]);
    if (reconcileSeq !== liveReconcileSeqRef.current || !liveConnectedRef.current) return;
    const id = conversationIdRef.current;
    if (!id || hasLocalRun(id)) return;
    const kind = conversations.find((item) => item.id === id)?.kind || conversationKindRef.current;
    await loadConversation(id, {
      resumeInFlight: true,
      restore: true,
      kind
    });
  }
  reconcileLiveConnectionRef.current = () => {
    void reconcileLiveConnection();
  };

  useEffect(() => {
    if (!listEntering) return;
    const timer = window.setTimeout(() => setListEntering(false), 520);
    return () => window.clearTimeout(timer);
  }, [listEntering]);

  useEffect(() => {
    if (previewSubagent) {
      setMessages(previewSubagentMessages());
    }
  }, [previewSubagent]);

  useEffect(() => {
    if (previewSubagent) return;
    if (!listReady || restoredSessionRef.current) return;
    if (incomingQuestion) {
      restoredSessionRef.current = true;
      composerReadyRef.current = true;
      return;
    }
    if (authLoading || !user?.id) return;
    const active = readActiveConversation(config.panelStorageKey, user.id);
    restoredSessionRef.current = true;
    void restoreComposerDraft();
    if (!active?.conversationId) return;
    void loadConversation(active.conversationId, {
      resumeInFlight: true,
      restore: true,
      kind: active.kind
    });
  }, [authLoading, config.panelStorageKey, incomingQuestion, listReady, user?.id]);

  useEffect(() => {
    if (!composerReadyRef.current || composerHydratingRef.current) return;
    const timer = window.setTimeout(() => {
      persistCurrentComposerDraft();
    }, 160);
    return () => window.clearTimeout(timer);
  }, [question, composerTool, pendingAttachments]);

  useEffect(() => {
    function persist() {
      persistCurrentComposerDraft();
    }
    window.addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', persist);
    return () => {
      persist();
      window.removeEventListener('pagehide', persist);
      document.removeEventListener('visibilitychange', persist);
    };
  }, []);

  useEffect(() => {
    if (!incomingQuestion || loading || lastIncomingQuestionRef.current === incomingQuestion) return;
    lastIncomingQuestionRef.current = incomingQuestion;
    setQuestion('');
    void ask(undefined, incomingQuestion);
  }, [incomingQuestion, loading]);

  const scrollFingerprint = useMemo(() => {
    const streaming = messages.find((message) => message.id === streamingMessageId);
    const stepCount = streaming?.agentSteps?.length || 0;
    const lastStep = streaming?.agentSteps?.[stepCount - 1];
    const stepSig = lastStep ? `${lastStep.step}:${lastStep.type}:${lastStep.content.length}` : '';
    const contentLen = streaming?.content?.length || 0;
    const sourceCount = streaming?.sources?.length || 0;
    return `${messages.length}:${stepCount}:${stepSig}:${contentLen}:${sourceCount}:${loading ? 1 : 0}`;
  }, [messages, streamingMessageId, loading]);
  const stickResetKey = useMemo(
    () => `${conversationId}:${messages.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0)}`,
    [conversationId, messages]
  );

  async function loadConversations(options?: { bypassCache?: boolean }) {
    const userId = authUserIdRef.current;
    if (!userId) return;
    const loadSeq = ++conversationListLoadSeqRef.current;
    const chatUrl = `${config.apiBase}/conversations`;
    const reviewUrl = `${RESEARCH_REVIEW_API_BASE}/conversations`;
    const chatKey = `${chatUrl}::user=${encodeURIComponent(userId)}`;
    const reviewKey = `${reviewUrl}::user=${encodeURIComponent(userId)}`;
    const isCurrentLoad = () => (
      loadSeq === conversationListLoadSeqRef.current
      && userId === authUserIdRef.current
    );
    if (options?.bypassCache) {
      invalidateDashboardListCache(chatKey);
      if (composerToolsEnabled) invalidateDashboardListCache(reviewKey);
    }
    try {
      const requests: Array<Promise<Conversation[]>> = [
        readDashboardListCache(chatKey, async () => {
          const response = await fetch(chatUrl);
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || '加载历史失败');
          return (Array.isArray(data.conversations) ? data.conversations : []) as Conversation[];
        })
      ];
      if (composerToolsEnabled) {
        requests.push(
          readDashboardListCache(reviewKey, async () => {
            const response = await fetch(reviewUrl);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) return [];
            return (Array.isArray(data.conversations) ? data.conversations : []).map((item: Conversation) => ({
              ...item,
              kind: 'research-review' as const
            }));
          }).catch(() => [])
        );
      }
      const lists = await Promise.all(requests);
      if (!isCurrentLoad()) return;
      const remote = lists.flat();
      setConversations((current) => mergeConversationLists(current, remote));
      setGeneratingIds((current) => {
        const next = new Set<string>();
        for (const item of remote) {
          if (item.generating) next.add(item.id);
        }
        for (const [id, run] of liveRunsRef.current) {
          if (run && !run.controller.signal.aborted) next.add(id);
        }
        if (controllerRef.current && conversationIdRef.current) {
          next.add(conversationIdRef.current);
        }
        for (const id of current) {
          const row = remote.find((item) => item.id === id);
          if (!row || row.generating) next.add(id);
        }
        const settled = [...current].filter((id) => !next.has(id));
        if (settled.length) {
          queueMicrotask(() => {
            for (const id of settled) noteGenerationSettled(id);
          });
        }
        generatingIdsRef.current = next;
        const viewingId = conversationIdRef.current;
        if (
          viewingId
          && !remote.some((item) => item.id === viewingId)
          && !hasLocalRun(viewingId)
        ) {
          queueMicrotask(() => startNewConversation());
        } else if (
          viewingId
          && !hasLocalRun(viewingId)
          && !liveConnectedRef.current
          && remote.some((item) => item.id === viewingId && item.generating)
        ) {
          queueMicrotask(() => resumeInFlightIfNeeded([], viewingId, true));
        }
        return next;
      });
      if (!listIntroPlayedRef.current && remote.length) {
        listIntroPlayedRef.current = true;
        setListEntering(true);
      }
    } catch (err) {
      if (!isCurrentLoad()) return;
      setError(err instanceof Error ? err.message : '加载历史失败');
    } finally {
      if (isCurrentLoad()) setListReady(true);
    }
  }

  function updateMessage(id: string, updater: (message: ChatMessage) => ChatMessage) {
    setMessages((current) => current.map((message) => (message.id === id ? updater(message) : message)));
  }

  async function recoverDeliveredAttachments(
    id: string,
    assistantId: string,
    kind: ChatConversationKind
  ) {
    if (!id || kind !== 'chat') return false;
    const userId = authUserIdRef.current;
    if (!userId) return false;
    // The server performs its own settling scan. These delayed reads cover the
    // remaining race where the done event arrives before that scan can observe
    // a file written by a sidecar tool, while keeping the UI responsive.
    const retryDelays = [0, 250, 650, 1_400, 2_600];
    for (const delay of retryDelays) {
      if (delay > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
      if (userId !== authUserIdRef.current || conversationIdRef.current !== id) return false;
      try {
        const response = await fetch(`${apiBaseForKind(kind)}/conversations/${encodeURIComponent(id)}`);
        if (!response.ok) continue;
        const data = await response.json().catch(() => ({})) as { messages?: ChatMessage[]; generating?: boolean };
        if (userId !== authUserIdRef.current || conversationIdRef.current !== id) return false;
        const target = Array.isArray(data.messages)
          ? data.messages.find((message) => message.id === assistantId)
            || [...data.messages].reverse().find((message) => message.role === 'assistant')
          : undefined;
        const attachments = target?.attachments || [];
        if (!attachments.length) {
          // Once the server reports a settled run it has already attempted its
          // own recovery scan; do not add latency to ordinary no-file answers.
          if (!data.generating) return false;
          continue;
        }
        updateMessage(assistantId, (message) => ({
          ...message,
          attachments: [
            ...(message.attachments || []).filter((item) => !attachments.some((next) => next.id === item.id)),
            ...attachments
          ]
        }));
        setSidePluginId(ATTACHMENT_SIDE_PLUGIN_ID);
        setSidePluginOpen(true);
        return true;
      } catch {
        // A transient read failure should not hide an attachment that is still
        // being finalized by the server.
      }
    }
    return false;
  }

  function startNewConversation(options?: { composerTool?: ComposerToolId | null; keepComposer?: boolean }) {
    const keepComposer = options?.keepComposer !== false;
    conversationLoadSeqRef.current += 1;
    conversationLoadTargetRef.current = '';
    detachInFlight();
    remoteSyncRef.current = null;
    writeActiveConversation(config.panelStorageKey, authUserIdRef.current, null);
    keepLocalPendingFiles();
    persistCurrentComposerDraft();
    if (!keepComposer) {
      setPendingAttachmentState([]);
      setQuestion('');
      questionRef.current = '';
      clearComposerDraft(currentComposerDraftKey());
    }
    setMessages(initialMessages);
    conversationIdRef.current = '';
    conversationTitleRef.current = '新会话';
    titleRequestIdRef.current = '';
    setConversationId('');
    setConversationTitle('新会话');
    setError('');
    setStatusDetail('正在理解问题…');
    setLoading(false);
    loadingRef.current = false;
    setStreamingMessageId('');
    setModalSource(null);
    setModalAttachment(null);
    setKnowledgeGraphOpen(false);
    setStatusDetail('');
    setHistoryOpen(false);
    const nextTool = options && 'composerTool' in options ? (options.composerTool ?? null) : composerToolRef.current;
    composerToolRef.current = nextTool;
    setComposerTool(nextTool);
    const nextKind = conversationKindForTool(nextTool);
    conversationKindRef.current = nextKind;
    setConversationKind(nextKind);
    setWelcomeLine(pickWelcomePrompt(
      welcomePromptsForTool(nextTool, config.welcomePrompts)
    ));
    setWelcomeKey((key) => key + 1);
    setReasoningRatio(defaultChatThinkingRatio(DEFAULT_CHAT_MODEL));
    setChatModel(DEFAULT_CHAT_MODEL);
    conversationStartedRef.current = false;
    if (nextTool !== 'patent') {
      window.requestAnimationFrame(() => {
        questionInputRef.current?.focus({ preventScroll: true });
      });
    }
  }

  function selectComposerTool(tool: ComposerToolId | null) {
    const nextKind = conversationKindForTool(tool);
    const currentKind = conversationKindRef.current;
    if (currentKind !== nextKind && conversationIdRef.current) {
      conversationLoadSeqRef.current += 1;
      conversationLoadTargetRef.current = '';
      persistCurrentComposerDraft();
      detachInFlight();
      writeActiveConversation(config.panelStorageKey, authUserIdRef.current, null);
      keepLocalPendingFiles();
      conversationIdRef.current = '';
      conversationTitleRef.current = '新会话';
      titleRequestIdRef.current = '';
      setConversationId('');
      setConversationTitle('新会话');
      setMessages(initialMessages);
      conversationStartedRef.current = false;
      setReasoningRatio(defaultChatThinkingRatio(DEFAULT_CHAT_MODEL));
      setChatModel(DEFAULT_CHAT_MODEL);
      setHistoryOpen(false);
    }
    composerToolRef.current = tool;
    conversationKindRef.current = nextKind;
    setComposerTool(tool);
    setConversationKind(nextKind);
    syncComposerToolUrl(tool);
    if (!conversationIdRef.current) {
      setWelcomeLine(pickWelcomePrompt(
        welcomePromptsForTool(tool, config.welcomePrompts)
      ));
      setWelcomeKey((key) => key + 1);
    }
    if (tool !== 'patent') {
      window.requestAnimationFrame(() => {
        questionInputRef.current?.focus({ preventScroll: true });
      });
    }
  }

  function attachmentDownloadHref(attachment: ChatAttachment) {
    if (attachment.downloadUrl) return attachment.downloadUrl;
    return attachment.previewUrl.includes('?')
      ? `${attachment.previewUrl}&download=1`
      : `${attachment.previewUrl}?download=1`;
  }

  async function downloadConversationAttachment(attachment: ChatAttachment) {
    try {
      const response = await fetch(attachmentDownloadHref(attachment), { method: 'GET' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `下载失败（${response.status}）`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      // Keep the object URL alive until the browser has consumed the click.
      window.setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(url);
      }, 1_000);
      setStatusDetail(`已下载 ${attachment.name}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : '附件下载失败。');
    }
  }

  async function downloadResearchArtifact(artifact: ResearchReviewArtifact) {
    try {
      const response = await fetch(artifact.downloadUrl, { method: 'GET' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `下载失败（${response.status}）`);
      }
      const blob = await response.blob();
      const rawName = (artifact.fileName || artifact.reportTitle || '科研综述').trim();
      const fileName = /\.docx$/i.test(rawName) ? rawName : `${rawName}.docx`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      window.setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(url);
      }, 1_000);
      setStatusDetail(`已下载 ${fileName}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : '下载 Word 失败。');
    }
  }

  function interruptConversation(id: string, options?: { notify?: boolean; drain?: boolean }) {
    stopResumePoll();
    if (!id) return;
    skipCompletedNoticeRef.current.add(id);
    requestStopGeneration(id);
    markConversationGenerating(id, false);
    liveRunsRef.current.get(id)?.controller.abort();
    liveRunsRef.current.delete(id);
    if (conversationIdRef.current !== id) {
      if (options?.drain) scheduleDrainSendQueue(id);
      return;
    }
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
    requestSeqRef.current += 1;
    if (options?.notify && streamingMessageId) {
      updateMessage(streamingMessageId, (message) => ({
        ...message,
        content: message.content
          ? `${message.content}\n\n（生成中断，以上为已收到的部分内容。）`
          : '生成已中断。',
        thinkingDurationMs: freezeThinkingDurationMs(message)
      }));
      setStatusDetail('生成已中断');
    } else {
      setStatusDetail('');
    }
    setLoading(false);
    loadingRef.current = false;
    setStreamingMessageId('');
    if (options?.drain) scheduleDrainSendQueue(id);
  }

  function stopGeneration() {
    interruptConversation(conversationIdRef.current, { notify: true, drain: true });
  }

  function interruptInFlight() {
    interruptConversation(conversationIdRef.current);
  }

  function isConversationGenerating(id: string) {
    if (!id) return false;
    const live = liveRunsRef.current.get(id);
    if (live && !live.controller.signal.aborted) return true;
    if (conversationIdRef.current === id && (loadingRef.current || Boolean(controllerRef.current))) return true;
    return generatingIdsRef.current.has(id);
  }

  function setSendQueueState(next: ChatQueuedTurn[]) {
    sendQueueRef.current = next;
    setSendQueue(next);
  }

  async function refreshSendQueue(options?: { drain?: boolean }) {
    const loadSeq = ++sendQueueLoadSeqRef.current;
    const userId = authUserIdRef.current;
    const items = await fetchSendQueue();
    if (loadSeq !== sendQueueLoadSeqRef.current || userId !== authUserIdRef.current) return items;
    setSendQueueState(items);
    const id = conversationIdRef.current;
    if (options?.drain !== false && id) {
      scheduleDrainSendQueue(id);
    }
    return items;
  }

  async function enqueueSendTurn(
    input: Omit<ChatQueuedTurn, 'id' | 'createdAt' | 'userMessageId' | 'assistantMessageId'>
  ) {
    const userId = authUserIdRef.current;
    const item = await createSendQueueItem({
      conversationId: input.conversationId,
      question: input.question,
      attachmentIds: input.attachments.map((attachment) => attachment.id)
    });
    if (userId !== authUserIdRef.current) return;
    setSendQueueState([...sendQueueRef.current.filter((entry) => entry.id !== item.id), item]);
    setSidePluginId(QUEUE_SIDE_PLUGIN_ID);
    setSidePluginOpen(true);
    notify.info('已加入排队，当前回答结束后自动发送');
  }

  async function removeQueuedTurn(id: string) {
    const userId = authUserIdRef.current;
    try {
      await deleteSendQueueItem(id);
      if (userId !== authUserIdRef.current) return;
      setSendQueueState(sendQueueRef.current.filter((item) => item.id !== id));
    } catch (error) {
      if (userId !== authUserIdRef.current) return;
      setError(error instanceof Error ? error.message : '移除排队失败');
    }
  }

  async function takeNextQueuedTurn(conversationId: string) {
    const userId = authUserIdRef.current;
    try {
      const item = await peekNextSendQueueItem(conversationId);
      return userId === authUserIdRef.current ? item : null;
    } catch (error) {
      if (userId !== authUserIdRef.current) return null;
      setError(error instanceof Error ? error.message : '取出排队失败');
      return null;
    }
  }

  function scheduleDrainSendQueue(conversationId: string) {
    if (!conversationId) return;
    window.setTimeout(() => {
      drainSendQueueRef.current(conversationId);
    }, 0);
  }

  async function drainSendQueue(conversationId: string) {
    if (!conversationId) return;
    if (conversationIdRef.current !== conversationId) return;
    if (isConversationGenerating(conversationId)) return;
    if (drainInFlightRef.current === conversationId) return;
    drainInFlightRef.current = conversationId;
    try {
      if (isConversationGenerating(conversationId)) return;
      const next = await takeNextQueuedTurn(conversationId);
      if (!next) return;
      if (isConversationGenerating(conversationId)) return;
      await ask(undefined, next.question, {
        attachments: next.attachments,
        force: true,
        queueItemId: next.id,
        queueConversationId: next.conversationId,
        queuedUserMessageId: next.userMessageId,
        queuedAssistantMessageId: next.assistantMessageId
      });
    } finally {
      if (drainInFlightRef.current === conversationId) {
        drainInFlightRef.current = '';
      }
    }
  }
  drainSendQueueRef.current = (conversationId: string) => {
    void drainSendQueue(conversationId);
  };

  async function sendQueuedNow(id: string) {
    const item = sendQueueRef.current.find((entry) => entry.id === id);
    if (!item) return;
    void ask(undefined, item.question, {
      attachments: item.attachments,
      force: true,
      queueItemId: item.id,
      queueConversationId: item.conversationId,
      queuedUserMessageId: item.userMessageId,
      queuedAssistantMessageId: item.assistantMessageId
    });
  }

  function applyLoadedHistory(raw: ChatMessage[]) {
    const next = mapLoadedMessages(raw);
    setMessages(next.length ? next : initialMessages);
    setLoading(false);
    setStreamingMessageId('');
    setStatusDetail('');
  }

  /** 打断当前生成（如有），从指定用户消息处截断并重新发送。 */
  function resendUserMessage(messageId: string) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const target = messages[index];
    if (target.role !== 'user') return;
    const baseMessages = messages.slice(0, index).filter((message) => message.id !== 'welcome');
    void ask(undefined, target.content, {
      baseMessages,
      attachments: target.attachments || [],
      truncateFromMessageId: target.id,
      truncateKeepCount: baseMessages.length
    });
  }

  function resendFromMessage(messageId: string) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    const target = messages[index];
    if (target.role === 'user') {
      resendUserMessage(target.id);
      return;
    }
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user' && messages[i].id !== 'welcome') {
        resendUserMessage(messages[i].id);
        return;
      }
    }
  }

  function lastUserInputForRevert(messageId: string) {
    const index = messages.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    if (messages[index].role === 'user') return messages[index];
    for (let i = index - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user' && messages[i].id !== 'welcome') return messages[i];
    }
    return null;
  }

  function restoreComposerInput(content: string, attachments: ChatAttachment[]) {
    discardPendingAttachments();
    setQuestion(content);
    setPendingAttachmentState(
      attachments.length ? pendingFromMessageAttachments(attachments) : []
    );
    window.requestAnimationFrame(() => {
      questionInputRef.current?.focus({ preventScroll: true });
    });
  }

  async function revertFromMessage(messageId: string) {
    const id = conversationIdRef.current;
    const userId = authUserIdRef.current;
    if (!id || historyEditing) return;
    const isCurrentAction = () => (
      userId === authUserIdRef.current && id === conversationIdRef.current
    );
    const restore = lastUserInputForRevert(messageId);
    const truncateId = restore?.id || messageId;
    const restoreQuestion = restore?.content || '';
    const restoreAttachments = [...(restore?.attachments || [])];
    interruptConversation(id);
    setError('');
    setHistoryEditing(true);
    try {
      const response = await fetch(
        `/api/chat/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(truncateId)}/revert`,
        { method: 'POST' }
      );
      const data = await response.json().catch(() => ({})) as { error?: string; messages?: ChatMessage[] };
      if (!isCurrentAction()) return;
      if (!response.ok) throw new Error(data.error || '回撤失败');
      applyLoadedHistory(Array.isArray(data.messages) ? data.messages : []);
      restoreComposerInput(restoreQuestion, restoreAttachments);
      void loadConversations({ bypassCache: true });
    } catch (err) {
      if (!isCurrentAction()) return;
      setError(err instanceof Error ? err.message : '回撤失败');
    } finally {
      if (userId === authUserIdRef.current) setHistoryEditing(false);
    }
  }

  async function deleteMessageRecord(messageId: string) {
    const id = conversationIdRef.current;
    const userId = authUserIdRef.current;
    if (!id || historyEditing) return;
    const isCurrentAction = () => (
      userId === authUserIdRef.current && id === conversationIdRef.current
    );
    interruptConversation(id);
    setError('');
    setHistoryEditing(true);
    try {
      const response = await fetch(
        `/api/chat/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' }
      );
      const data = await response.json().catch(() => ({})) as { error?: string; messages?: ChatMessage[] };
      if (!isCurrentAction()) return;
      if (!response.ok) throw new Error(data.error || '删除消息失败');
      applyLoadedHistory(Array.isArray(data.messages) ? data.messages : []);
      void loadConversations({ bypassCache: true });
    } catch (err) {
      if (!isCurrentAction()) return;
      setError(err instanceof Error ? err.message : '删除消息失败');
    } finally {
      if (userId === authUserIdRef.current) setHistoryEditing(false);
    }
  }

  function mapLoadedMessages(raw: ChatMessage[]): ChatMessage[] {
    return raw.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      attachments: message.attachments || [],
      artifacts: message.artifacts || [],
      sources: message.sources || [],
      graphSeedIds: message.graphSeedIds || [],
      agentSteps: message.agentSteps || [],
      thinkingDurationMs: message.thinkingDurationMs,
      createdAt: message.createdAt,
      contextUsage: message.contextUsage,
      inProgress: message.inProgress
    }));
  }

  async function hydratePendingAsks(id: string, kind?: ChatConversationKind) {
    if (normalizeChatConversationKind(kind) === 'research-review') return;
    try {
      const response = await fetch(`/api/chat/conversations/${encodeURIComponent(id)}/question`);
      const data = await response.json().catch(() => ({})) as { questions?: ChatAskRequest[] };
      if (!response.ok || !Array.isArray(data.questions) || !data.questions.length) return;
      if (conversationIdRef.current !== id) return;
      setMessages((current) => {
        const target = [...current].reverse().find((message) => message.role === 'assistant');
        if (!target) return current;
        let steps = target.agentSteps || [];
        for (const request of data.questions || []) {
          steps = mergePendingAskIntoSteps(steps, request);
        }
        return current.map((message) => (
          message.id === target.id ? { ...message, agentSteps: steps } : message
        ));
      });
    } catch {
      // sidecar 未提问时忽略。
    }
  }

  async function replyChatAsk(request: ChatAskRequest, answers: string[][]) {
    const id = conversationIdRef.current;
    if (!id || !request.requestID) throw new Error('当前没有待确认的问题。');
    const response = await fetch(`/api/chat/conversations/${encodeURIComponent(id)}/question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestID: request.requestID,
        questions: request.questions,
        answers
      })
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error || '提交询问答复失败');
    setStatusDetail('已收到选择，继续处理…');
    setMessages((current) => {
      const targetId = streamingMessageId
        || [...current].reverse().find((message) => message.role === 'assistant')?.id;
      return current.map((message) => {
        if (message.id !== targetId) return message;
        return {
          ...message,
          agentSteps: (message.agentSteps || []).map((step) => {
            if (!isQuestionToolName(step.tool) || step.type !== 'tool_call') return step;
            if (String(step.input?.requestID || step.toolCallId || '') !== request.requestID) return step;
            return {
              ...step,
              input: {
                ...(step.input || {}),
                pending: false,
                answers
              },
              content: `已确认：${answers.flat().filter(Boolean).join('、')}`
            };
          })
        };
      });
    });
  }

  function resumeInFlightIfNeeded(loadedMessages: ChatMessage[], id: string, generating = false) {
    const inflight = [...loadedMessages].reverse().find((message) => isInFlightAssistantMessage(message));
    if (!inflight && !generating) return;
    stopResumePoll();
    const seq = resumePollSeqRef.current;
    setStreamingMessageId(inflight?.id || '');
    setLoading(true);
    loadingRef.current = true;
    setStatusDetail('正在继续生成…');
    void hydratePendingAsks(id, conversations.find((item) => item.id === id)?.kind || conversationKindRef.current);
    const poll = async () => {
      if (resumePollSeqRef.current !== seq || conversationIdRef.current !== id) return;
      try {
        const kind = conversations.find((item) => item.id === id)?.kind || conversationKindRef.current;
        const response = await fetch(`${apiBaseForKind(kind)}/conversations/${encodeURIComponent(id)}`);
        const data = await response.json().catch(() => ({}));
        if (resumePollSeqRef.current !== seq) return;
        if (response.ok && Array.isArray(data.messages)) {
          const nextMessages = mapLoadedMessages(data.messages);
          setMessages(nextMessages.length ? nextMessages : initialMessages);
          const stillRunning = Boolean(data.generating)
            || nextMessages.some((message) => isInFlightAssistantMessage(message));
          if (stillRunning) void hydratePendingAsks(id, kind);
          if (!stillRunning) {
            setLoading(false);
            loadingRef.current = false;
            setStreamingMessageId('');
            setStatusDetail('');
            void loadConversations({ bypassCache: true });
            scheduleDrainSendQueue(id);
            return;
          }
          const nextInflight = [...nextMessages].reverse().find((message) => isInFlightAssistantMessage(message));
          if (nextInflight) setStreamingMessageId(nextInflight.id);
        }
      } catch {
        // keep polling through transient disconnects
      }
      resumePollRef.current = setTimeout(() => {
        void poll();
      }, 2_000);
    };
    resumePollRef.current = setTimeout(() => {
      void poll();
    }, 1_200);
  }

  async function loadConversation(
    id: string,
    options?: { resumeInFlight?: boolean; restore?: boolean; kind?: ChatConversationKind }
  ) {
    clearConversationUnread(id);
    if (!options?.restore && conversationIdRef.current === id) {
      setHistoryOpen(false);
      return;
    }
    const loadSeq = ++conversationLoadSeqRef.current;
    conversationLoadTargetRef.current = id;
    const activeConversationIdAtStart = conversationIdRef.current;
    const userIdAtStart = authUserIdRef.current;
    const isCurrentLoad = () => mountedRef.current && canApplyConversationLoad({
      requestSeq: loadSeq,
      latestSeq: conversationLoadSeqRef.current,
      requestedConversationId: id,
      activeConversationIdAtStart,
      currentConversationId: conversationIdRef.current,
      userIdAtStart,
      currentUserId: authUserIdRef.current
    });
    if (conversationIdRef.current && conversationIdRef.current !== id) {
      persistCurrentComposerDraft();
      detachInFlight();
    }
    stopResumePoll();
    remoteSyncRef.current = null;
    setError('');
    try {
      const known = conversations.find((item) => item.id === id);
      const kind = normalizeChatConversationKind(options?.kind || known?.kind);
      const response = await fetch(`${apiBaseForKind(kind)}/conversations/${encodeURIComponent(id)}`);
      const data = await response.json().catch(() => ({}));
      if (!isCurrentLoad()) return;
      if (!response.ok) {
        if (response.status === 404 && options?.restore) {
          conversationIdRef.current = '';
          setConversationId('');
          setConversationTitle('新会话');
          setMessages(initialMessages);
          writeActiveConversation(config.panelStorageKey, authUserIdRef.current, null);
          return;
        }
        throw new Error(data.error || '加载会话失败');
      }
      const loadedMessages: ChatMessage[] = Array.isArray(data.messages)
        ? mapLoadedMessages(data.messages)
        : [];
      conversationIdRef.current = data.conversation.id;
      conversationTitleRef.current = data.conversation.title;
      titleRequestIdRef.current = isUntitledConversation(data.conversation.title) ? '' : data.conversation.id;
      setConversationId(data.conversation.id);
      setConversationTitle(data.conversation.title);
      conversationKindRef.current = kind;
      setConversationKind(kind);
      const storedChatModel = parseChatModelId(data.conversation?.chat_model)
        || (parseChatThunder(data.conversation?.thunder) ? 'thunder' : null);
      const savedModel = storedChatModel
        || normalizeChatModelId(data.conversation?.chat_model, DEFAULT_CHAT_MODEL);
      const savedRatio = Number(data.conversation?.reasoning_ratio);
      const savedLevels = thinkingCatalogs[savedModel] || fallbackThinkingLevels(savedModel);
      setChatModel(savedModel);
      setReasoningRatio(
        Number.isFinite(savedRatio)
          ? snapChatReasoningRatio(savedRatio, savedLevels)
          : defaultChatThinkingRatio(savedModel)
      );
      setMessages(loadedMessages.length ? loadedMessages : initialMessages);
      setStatusDetail('');
      const liveRun = liveRunsRef.current.get(data.conversation.id);
      const liveController = liveRun?.controller;
      const liveGenerating = Boolean(liveController && !liveController.signal.aborted)
        || generatingIds.has(data.conversation.id)
        || data.generating === true;
      if (liveController && !liveController.signal.aborted) {
        controllerRef.current = liveController;
        setLoading(true);
        loadingRef.current = true;
        const inflight = [...loadedMessages].reverse().find((message) => isInFlightAssistantMessage(message));
        setStreamingMessageId(inflight?.id || '');
        setStatusDetail('正在继续生成…');
      } else if (
        options?.resumeInFlight !== false
        && !liveConnectedRef.current
        && (
          liveGenerating
          || loadedMessages.some((message) => isInFlightAssistantMessage(message))
        )
      ) {
        resumeInFlightIfNeeded(loadedMessages, data.conversation.id, data.generating === true || liveGenerating);
      } else if (
        liveConnectedRef.current
        && (
          liveGenerating
          || loadedMessages.some((message) => isInFlightAssistantMessage(message))
        )
      ) {
        const inflight = [...loadedMessages].reverse().find((message) => isInFlightAssistantMessage(message));
        setLoading(true);
        loadingRef.current = true;
        setStreamingMessageId(inflight?.id || '');
        setStatusDetail('正在同步其它端的生成进度…');
        markConversationGenerating(data.conversation.id, true);
      } else {
        setLoading(false);
        setStreamingMessageId('');
        scheduleDrainSendQueue(data.conversation.id);
      }
      setHistoryOpen(false);
    } catch (err) {
      if (!isCurrentLoad()) return;
      setError(err instanceof Error ? err.message : '加载会话失败');
    } finally {
      if (
        conversationLoadSeqRef.current === loadSeq
        && conversationLoadTargetRef.current === id
      ) {
        conversationLoadTargetRef.current = '';
      }
    }
  }

  function isUntitledConversation(title?: string | null) {
    const compact = String(title || '').trim();
    return !compact || compact === '新会话' || compact === '新对话';
  }

  async function ensureConversationTitle(id: string, question?: string) {
    if (!id) return;
    const userId = authUserIdRef.current;
    if (!userId) return;
    // Already named in this client session — never re-title mid-conversation.
    if (conversationIdRef.current === id && !isUntitledConversation(conversationTitleRef.current)) return;
    if (titleRequestIdRef.current === id) return;
    const known = conversations.find((item) => item.id === id);
    if (known && !isUntitledConversation(known.title)) {
      applyConversationTitle(id, known.title);
      return;
    }
    titleRequestIdRef.current = id;
    const retryWaits = [120, 240, 400, 700, 1100, 1800];
    try {
      const kind = conversations.find((item) => item.id === id)?.kind || conversationKindRef.current;
      for (let attempt = 0; attempt <= retryWaits.length; attempt += 1) {
        if (titleRequestIdRef.current !== id) return;
        const response = await fetch(`${apiBaseForKind(kind)}/conversations/${encodeURIComponent(id)}/title`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(question ? { question } : {})
        });
        if (titleRequestIdRef.current !== id || userId !== authUserIdRef.current) return;
        if (response.status === 404 || response.status === 409) {
          const wait = retryWaits[attempt];
          if (wait == null) return;
          await new Promise((resolve) => window.setTimeout(resolve, wait));
          continue;
        }
        const data = await response.json().catch(() => ({})) as {
          conversation?: { id?: string; title?: string };
          skipped?: boolean;
          error?: string;
        };
        if (titleRequestIdRef.current !== id || userId !== authUserIdRef.current) return;
        if (!response.ok || !data.conversation?.title) return;
        const nextTitle = data.conversation.title;
        if (data.skipped && isUntitledConversation(nextTitle)) return;
        applyConversationTitle(id, nextTitle);
        invalidateDashboardListCache(`${apiBaseForKind(kind)}/conversations`);
        return;
      }
    } catch {
      // 标题生成失败时保持「新会话」，不影响主对话。
    } finally {
      if (titleRequestIdRef.current === id) titleRequestIdRef.current = '';
    }
  }

  async function deleteConversation(id: string) {
    const userId = authUserIdRef.current;
    const kind = conversations.find((item) => item.id === id)?.kind || conversationKindRef.current;
    const isCurrentAction = () => userId === authUserIdRef.current;
    setError('');
    try {
      const response = await fetch(`${apiBaseForKind(kind)}/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!isCurrentAction()) return;
      if (!response.ok) throw new Error(data.error || '删除会话失败');
      interruptConversation(id);
      clearConversationUnread(id);
      setSendQueueState(sendQueueRef.current.filter((item) => item.conversationId !== id));
      if (conversationId === id) startNewConversation();
      await loadConversations({ bypassCache: true });
    } catch (err) {
      if (!isCurrentAction()) return;
      setError(err instanceof Error ? err.message : '删除会话失败');
    }
  }

  function applyConversationTitle(id: string, nextTitle: string) {
    if (!id || isUntitledConversation(nextTitle)) return;
    if (shouldUpdateActiveConversationTitle(id, conversationIdRef.current)) {
      conversationTitleRef.current = nextTitle;
      setConversationTitle(nextTitle);
    }
    setConversations((current) => {
      const exists = current.some((item) => item.id === id);
      if (!exists) {
        const now = new Date().toISOString();
        return sortConversationsByLastUser([
          {
            id,
            title: nextTitle,
            created_at: now,
            updated_at: now,
            last_user_at: now,
            messageCount: 1,
            kind: conversationKindRef.current
          },
          ...current
        ]);
      }
      return current.map((item) =>
        item.id === id
          ? { ...item, title: nextTitle }
          : item
      );
    });
  }

  function applyStreamEvent(event: StreamEvent, assistantId: string, runConversationId: string, options?: { kind?: ChatConversationKind }) {
    const viewing = conversationIdRef.current === runConversationId;
    if (event.type === 'title') {
      applyConversationTitle(event.conversationId, event.title);
      return false;
    }
    if (event.type === 'meta') {
      if (viewing) {
        // Stream meta always sends the default title for new turns — keep an existing name.
        setConversationTitle((current) => {
          if (!isUntitledConversation(current)) return current;
          const incoming = event.title || '新会话';
          return isUntitledConversation(incoming) ? current || '新会话' : incoming;
        });
        if (isChatModelId(event.chatModel)) {
          setChatModel(event.chatModel);
          const levels = thinkingCatalogs[event.chatModel] || fallbackThinkingLevels(event.chatModel);
          if (typeof event.reasoningRatio === 'number') {
            setReasoningRatio(snapChatReasoningRatio(event.reasoningRatio, levels));
          }
        }
      }
      if (event.conversationId) {
        const eventKind = options?.kind || outgoingComposerKind();
        if (viewing) {
          conversationKindRef.current = eventKind;
          setConversationKind(eventKind);
        }
        setConversations((current) => {
          const exists = current.some((item) => item.id === event.conversationId);
          if (!exists) {
            const now = new Date().toISOString();
            const liveTitle = viewing ? conversationTitleRef.current : (event.title || '新会话');
            return sortConversationsByLastUser([
              {
                id: event.conversationId,
                title: isUntitledConversation(liveTitle) ? (event.title || '新会话') : liveTitle,
                created_at: now,
                updated_at: now,
                last_user_at: now,
                messageCount: 1,
                kind: eventKind,
                generating: true
              },
              ...current
            ]);
          }
          return current.map((item) =>
            item.id === event.conversationId
              ? {
                  ...item,
                  title: isUntitledConversation(event.title) ? item.title : (event.title || item.title),
                  kind: item.kind || eventKind,
                  generating: true
                }
              : item
          );
        });
      }
      if (viewing) {
        updateMessage(assistantId, (message) => ({
          ...message,
          sources: event.sources,
          graphSeedIds: event.graphSeedIds,
          ...(event.agentSteps
            ? { agentSteps: sortRuntimeAgentSteps(event.agentSteps) }
            : { agentSteps: thinkingStepsAfterTurn(message.agentSteps || []) }),
          ...(event.trace?.totalDurationMs != null
            ? { thinkingDurationMs: event.trace.totalDurationMs }
            : {}),
          ...(contextUsageFromMetrics(event.trace)
            ? { contextUsage: contextUsageFromMetrics(event.trace) }
            : {})
        }));
      }
      return false;
    }

    if (event.type === 'status') {
      if (viewing && event.phase !== 'heartbeat') {
        setStatusDetail(event.detail || event.message || '正在处理…');
      }
      return false;
    }

    if (event.type === 'agent_step') {
      if (viewing) {
        const summary = summarizeThinkStep(event.step);
        if (summary) {
          setStatusDetail(`${summary.verb}${summary.detail ? ` ${summary.detail}` : ''}`);
        } else if (event.step.type === 'thought') {
          setStatusDetail('正在思考…');
        } else if (event.step.type === 'public_text') {
          setStatusDetail('正在阅读与整理证据…');
        }
      }
      const applyStep = () => {
        updateMessage(assistantId, (message) => {
          const current = message.agentSteps || [];
          return {
            ...message,
            agentSteps: mergeRuntimeAgentStep(current, event.step)
          };
        });
      };
      if (viewing) flushSync(applyStep);
      return false;
    }

    if (event.type === 'context_usage') {
      if (viewing) {
        updateMessage(assistantId, (message) => ({ ...message, contextUsage: event.usage }));
      }
      return false;
    }

    if (event.type === 'chunk') {
      if (viewing) {
        setStatusDetail('正在生成答案…');
        flushSync(() => {
          updateMessage(assistantId, (message) => ({
            ...message,
            content: `${message.content}${event.content}`
          }));
        });
      }
      return true;
    }

    if (event.type === 'answer_reset') {
      if (viewing) {
        flushSync(() => {
          updateMessage(assistantId, (message) => ({
            ...message,
            content: ''
          }));
        });
      }
      return true;
    }

    if (event.type === 'answer_replace') {
      if (viewing) {
        setStatusDetail('正在生成答案…');
        flushSync(() => {
          updateMessage(assistantId, (message) => ({
            ...message,
            content: event.content
          }));
        });
      }
      return true;
    }

    if (event.type === 'error') {
      if (viewing) throw new Error(event.error || '查询失败');
      return false;
    }

    if (event.type === 'artifact') {
      if (viewing) {
        updateMessage(assistantId, (message) => {
          const current = message.artifacts || [];
          const next = [
            ...current.filter((item) => item.id !== event.artifact.id),
            event.artifact
          ];
          return { ...message, artifacts: next, sources: [], graphSeedIds: [] };
        });
        setStatusDetail(`Word 已放到右侧「附件查看」：${event.artifact.fileName}`);
      }
      return false;
    }

    if (event.type === 'done') {
      if (viewing) {
        const totalDurationMs = event.metrics?.totalDurationMs;
        const contextUsage = contextUsageFromMetrics(event.metrics);
        if (totalDurationMs != null || contextUsage || event.artifact || event.attachments?.length) {
          updateMessage(assistantId, (message) => {
            const artifacts = event.artifact
              ? [
                  ...(message.artifacts || []).filter((item) => item.id !== event.artifact!.id),
                  event.artifact
                ]
              : message.artifacts;
            const attachments = event.attachments?.length
              ? [
                  ...(message.attachments || []).filter((item) => !event.attachments!.some((next) => next.id === item.id)),
                  ...event.attachments
                ]
              : message.attachments;
            return {
              ...message,
              ...(totalDurationMs != null ? { thinkingDurationMs: totalDurationMs } : {}),
              ...(contextUsage ? { contextUsage } : {}),
              ...(artifacts ? { artifacts } : {}),
              ...(attachments ? { attachments } : {})
            };
          });
        }
        if (event.attachments?.length) {
          setSidePluginId(ATTACHMENT_SIDE_PLUGIN_ID);
          setSidePluginOpen(true);
        }
        setStatusDetail(
          event.attachments?.length
            ? `回答完成，已把 ${event.attachments.length} 个交付附件放到右侧「附件查看」`
            : event.artifact
              ? `已完成，请到右侧「附件查看」下载 ${event.artifact.fileName}`
              : '回答完成'
        );
      }
    }

    return false;
  }

  async function parseEventLine(line: string, assistantId: string, runConversationId: string) {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const event = JSON.parse(trimmed) as StreamEvent;
    const handled = applyStreamEvent(event, assistantId, runConversationId);
    if (
      conversationIdRef.current === runConversationId
      && (
        event.type === 'agent_step'
        || event.type === 'chunk'
        || event.type === 'answer_replace'
        || event.type === 'answer_reset'
      )
    ) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
    return handled;
  }

  function seedRemoteTurn(event: ChatLiveEvent) {
    const assistantId = event.assistantMessageId || '';
    if (!assistantId && !event.userMessageId) return '';
    const startedAt = Date.now();
    setMessages((current) => {
      const next = current.filter((message) => message.id !== 'welcome');
      if (event.userMessageId && !next.some((message) => message.id === event.userMessageId)) {
        next.push({
          id: event.userMessageId,
          role: 'user',
          content: event.userContent || '',
          createdAt: new Date().toISOString()
        });
      } else if (event.userMessageId && event.userContent) {
        const index = next.findIndex((message) => message.id === event.userMessageId);
        if (index >= 0 && !String(next[index].content || '').trim()) {
          next[index] = { ...next[index], content: event.userContent };
        }
      }
      if (assistantId && !next.some((message) => message.id === assistantId)) {
        next.push({
          id: assistantId,
          role: 'assistant',
          content: '',
          sources: [],
          graphSeedIds: [],
          agentSteps: [],
          startedAt,
          createdAt: new Date(startedAt).toISOString(),
          inProgress: true
        });
      } else if (assistantId) {
        return next.map((message) => (
          message.id === assistantId ? { ...message, inProgress: true } : message
        ));
      }
      return next;
    });
    return assistantId;
  }

  async function hydrateRemoteConversation(
    id: string,
    assistantId: string,
    sync: RemoteSyncState,
    kind?: ChatConversationKind
  ) {
    const isCurrentSync = () => canApplyRemoteConversationHydration(
      conversationIdRef.current,
      id,
      assistantId,
      sync,
      remoteSyncRef.current
    );
    try {
      const response = await fetch(`${apiBaseForKind(kind || conversationKindRef.current)}/conversations/${encodeURIComponent(id)}`);
      const data = await response.json().catch(() => ({})) as {
        messages?: ChatMessage[];
        generating?: boolean;
      };
      if (!isCurrentSync()) return false;
      if (!response.ok) return true;
      const queued = sync.queued;
      if (Array.isArray(data.messages) && data.messages.length) {
        const loaded = mapLoadedMessages(data.messages);
        const snapshotContent = [...loaded].reverse().find((message) => (
          message.id === assistantId || message.role === 'assistant'
        ))?.content || '';
        const reconciled = reconcileStreamAfterSnapshot({ snapshotContent, queued });
        setMessages(loaded.map((message) => (
          assistantId && message.id === assistantId && reconciled.replace
            ? { ...message, content: reconciled.content, inProgress: data.generating !== false }
            : message
        )));
        for (const queuedEvent of queued) {
          if (isIncrementalStreamEvent(queuedEvent) || queuedEvent.type === 'error') continue;
          applyStreamEvent(queuedEvent, assistantId, id, { kind });
        }
      }
      sync.queued = [];
      sync.ready = true;
      if (data.generating) {
        markConversationGenerating(id, true);
        setLoading(true);
        if (assistantId) setStreamingMessageId(assistantId);
      }
      return true;
    } catch {
      if (!isCurrentSync()) return false;
      sync.ready = true;
      for (const queuedEvent of sync.queued) {
        if (queuedEvent.type === 'error') continue;
        applyStreamEvent(queuedEvent, assistantId, id, { kind });
      }
      sync.queued = [];
      return true;
    }
  }

  function finishRemoteTurn(id: string, assistantId: string, kind: ChatConversationKind) {
    if (conversationIdRef.current !== id) {
      markConversationGenerating(id, false);
      return;
    }
    updateMessage(assistantId, (message) => ({ ...message, inProgress: false }));
    setLoading(false);
    loadingRef.current = false;
    setStreamingMessageId('');
    markConversationGenerating(id, false);
    void recoverDeliveredAttachments(id, assistantId, kind);
    scheduleDrainSendQueue(id);
  }

  function handleLiveEvent(event: ChatLiveEvent) {
    if (previewSubagent) return;
    const viewingId = conversationIdRef.current;
    const local = isLocalOriginator(event);
    if (shouldRefreshSendQueue(event)) {
      void (async () => {
        await loadConversations({ bypassCache: true });
        await refreshSendQueue({ drain: true });
      })();
    } else if (shouldRefreshConversationList(event)) {
      void loadConversations({ bypassCache: true });
    }
    if (
      shouldRefreshActiveConversation(event, viewingId)
      && canRefreshViewedConversation(viewingId, conversationLoadTargetRef.current)
      && !hasLocalRun(viewingId)
    ) {
      void loadConversation(viewingId, {
        restore: true,
        resumeInFlight: true,
        kind: event.kind || conversationKindRef.current
      });
    }
    if (event.type === 'delete' && event.conversationId && event.conversationId === viewingId && !local) {
      startNewConversation();
      return;
    }
    if (!event.conversationId || event.conversationId !== viewingId) return;
    if (event.type === 'stream' && conversationLoadTargetRef.current === viewingId) {
      conversationLoadSeqRef.current += 1;
      conversationLoadTargetRef.current = '';
    }
    if (local) return;

    const kind = event.kind || conversationKindRef.current;
    if (event.kind) {
      conversationKindRef.current = kind;
      setConversationKind(kind);
    }

    if (shouldSeedRemoteTurn(event, viewingId, local) && event.generating !== false) {
      const assistantId = seedRemoteTurn(event) || event.assistantMessageId || streamingMessageId;
      markConversationGenerating(viewingId, true);
      setLoading(true);
      loadingRef.current = true;
      if (assistantId) setStreamingMessageId(assistantId);
      setStatusDetail('正在同步其它端的生成进度…');
    }

    if (!shouldApplyRemoteStream(event, viewingId, local)) {
      if (event.generating === true) {
        stopResumePoll();
      } else if (event.generating === false && event.type === 'conversation') {
        const assistantId = event.assistantMessageId || streamingMessageId;
        if (assistantId) {
          let sync = remoteSyncRef.current;
          if (
            !sync
            || sync.conversationId !== viewingId
            || sync.assistantId !== assistantId
          ) {
            sync = {
              conversationId: viewingId,
              assistantId,
              queued: [],
              ready: false,
              syncing: null
            };
            remoteSyncRef.current = sync;
          }
          const expectedSync = sync;
          void hydrateRemoteConversation(viewingId, assistantId, expectedSync, kind).then((applied) => {
            if (applied) finishRemoteTurn(viewingId, assistantId, kind);
          });
        } else {
          setLoading(false);
          loadingRef.current = false;
          setStreamingMessageId('');
          markConversationGenerating(viewingId, false);
          scheduleDrainSendQueue(viewingId);
        }
      }
      return;
    }

    const inner = event.event as StreamEvent | undefined;
    const assistantId = event.assistantMessageId
      || remoteSyncRef.current?.assistantId
      || streamingMessageId;
    if (!inner || !assistantId) return;
    stopResumePoll();

    if (
      !remoteSyncRef.current
      || remoteSyncRef.current.conversationId !== viewingId
      || remoteSyncRef.current.assistantId !== assistantId
    ) {
      remoteSyncRef.current = {
        conversationId: viewingId,
        assistantId,
        queued: [],
        ready: false,
        syncing: null
      };
    }
    const sync = remoteSyncRef.current;
    if (!sync.ready) {
      sync.queued.push(inner);
      if (!sync.syncing) {
        sync.syncing = hydrateRemoteConversation(viewingId, assistantId, sync, kind).then(() => undefined).finally(() => {
          if (remoteSyncRef.current === sync) sync.syncing = null;
        });
      }
      if (inner.type === 'done') {
        applyStreamEvent(inner, assistantId, viewingId, { kind });
        finishRemoteTurn(viewingId, assistantId, kind);
        sync.ready = true;
      } else if (inner.type === 'error') {
        setError(inner.error || '查询失败');
        setStatusDetail('查询失败');
        finishRemoteTurn(viewingId, assistantId, kind);
        sync.ready = true;
      }
      return;
    }

    if (inner.type === 'error') {
      setError(inner.error || '查询失败');
      setStatusDetail('查询失败');
      finishRemoteTurn(viewingId, assistantId, kind);
      return;
    }
    applyStreamEvent(inner, assistantId, viewingId, { kind });
    if (inner.type === 'done') finishRemoteTurn(viewingId, assistantId, kind);
  }
  handleLiveEventRef.current = handleLiveEvent;

  async function ask(
    event?: FormEvent<HTMLFormElement>,
    overrideQuestion?: string,
    options?: {
      baseMessages?: ChatMessage[];
      attachments?: ChatAttachment[];
      truncateFromMessageId?: string;
      truncateKeepCount?: number;
      force?: boolean;
      queueItemId?: string;
      queueConversationId?: string;
      queuedUserMessageId?: string;
      queuedAssistantMessageId?: string;
    }
  ) {
    event?.preventDefault();
    const userIdAtStart = authUserIdRef.current;
    if (!userIdAtStart) return;
    const trimmed = (overrideQuestion ?? question).trim();
    const isResend = options?.baseMessages !== undefined;
    const isQueuedSend = Boolean(options?.queueItemId);
    const forceSend = options?.force === true || isResend;
    const pending = isResend || isQueuedSend ? [] : pendingAttachmentsRef.current;
    const uploadsInProgress = pending.some((attachment) =>
      ['queued', 'uploading', 'processing', 'removing'].includes(attachment.status)
    );
    if (uploadsInProgress) {
      setError('请等待附件处理完成后再发送。');
      return;
    }
    const readyPending = isResend || isQueuedSend ? [] : pending.filter(isLocalReadyPending);
    if (!trimmed && !readyPending.length && !options?.attachments?.length) return;

    const queuedConversationId = options?.queueConversationId || conversationIdRef.current;
    const outgoingKind = isQueuedSend
      ? normalizeChatConversationKind(
          conversations.find((item) => item.id === queuedConversationId)?.kind
            || conversationKindRef.current
        )
      : outgoingComposerKind();
    const currentConversationId = isQueuedSend
      ? queuedConversationId
      : (
          conversationKindRef.current === outgoingKind ? conversationIdRef.current : ''
        ) || createId();
    let messageAttachments = options?.attachments?.length ? options.attachments : [];
    if (!isResend && !isQueuedSend && !options?.attachments?.length) {
      try {
        messageAttachments = await flushPendingUploads(
          currentConversationId,
          apiBaseForKind(outgoingKind),
          userIdAtStart
        );
      } catch (error) {
        if (userIdAtStart !== authUserIdRef.current) return;
        setError(error instanceof Error ? error.message : '附件上传失败。');
        return;
      }
      if (userIdAtStart !== authUserIdRef.current) return;
    }
    const displayQuestion = trimmed
      || (outgoingKind === 'research-review' ? RESEARCH_REVIEW_ATTACHMENT_ONLY_QUESTION : ATTACHMENT_ONLY_QUESTION);
    if (
      !forceSend
      && currentConversationId
      && isConversationGenerating(currentConversationId)
    ) {
      try {
        await enqueueSendTurn({
          conversationId: currentConversationId,
          question: displayQuestion,
          attachments: messageAttachments
        });
      } catch (error) {
        if (userIdAtStart !== authUserIdRef.current) return;
        setError(error instanceof Error ? error.message : '加入排队失败');
        return;
      }
      if (userIdAtStart !== authUserIdRef.current) return;
      setQuestion('');
      questionRef.current = '';
      const sentClientIds = new Set(readyPending.map((attachment) => attachment.clientId));
      setPendingAttachmentState((current) => current.filter((attachment) => !sentClientIds.has(attachment.clientId)));
      clearComposerDraft(currentComposerDraftKey());
      return;
    }
    loadingRef.current = true;
    if (currentConversationId && !isResend && !forceSend && !messageAttachments.length) {
      try {
        const probed = await fetchConversationRunState(
          apiBaseForKind(outgoingKind),
          currentConversationId
        );
        if (userIdAtStart !== authUserIdRef.current) return;
        if (
          probed
          && shouldReuseActiveGeneration({
            question: displayQuestion,
            generating: probed.generating,
            messages: probed.messages as Array<{ role?: string; content?: string }>
          })
        ) {
          conversationIdRef.current = currentConversationId;
          setConversationId(currentConversationId);
          const loaded = mapLoadedMessages(probed.messages as ChatMessage[]);
          if (loaded.length) setMessages(loaded);
          setError('');
          setLoading(true);
          markConversationGenerating(currentConversationId, true);
          resumeInFlightIfNeeded(loaded, currentConversationId, true);
          setStatusDetail('上一轮仍在生成，已改为继续同步进度…');
          return;
        }
      } catch {
        if (userIdAtStart !== authUserIdRef.current) return;
        // Probe failure should not block a new turn.
      }
    }
    if (userIdAtStart !== authUserIdRef.current) return;
    if (
      liveRunsRef.current.has(currentConversationId)
      || (
        (conversationIdRef.current === currentConversationId || !conversationIdRef.current)
        && (loading || Boolean(controllerRef.current))
      )
    ) {
      interruptConversation(currentConversationId);
    }
    loadingRef.current = true;
    conversationIdRef.current = currentConversationId;
    setConversationId(currentConversationId);
    clearConversationUnread(currentConversationId);

    stopResumePoll();
    remoteSyncRef.current = null;
    const controller = new AbortController();
    const userMessageId = options?.queuedUserMessageId || createId();
    const assistantId = options?.queuedAssistantMessageId || createId();
    liveRunsRef.current.set(currentConversationId, {
      controller,
      userMessageId,
      assistantMessageId: assistantId
    });
    controllerRef.current = controller;
    const userMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: displayQuestion,
      attachments: messageAttachments,
      createdAt: new Date().toISOString()
    };
    const startedAt = Date.now();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      sources: [],
      graphSeedIds: [],
      agentSteps: [],
      startedAt,
      createdAt: new Date(startedAt).toISOString(),
      inProgress: true,
      chatModel: pickerModel,
      thinkingId: reasoningTier.thinkingId
    };
    const priorMessages = (options?.baseMessages
      ?? messagesRef.current.filter((message) => message.id !== 'welcome' && message.id !== streamingMessageId)
    ).filter((message) => message.id !== 'welcome');
    const cleanedPrior = priorMessages.filter((message) =>
      !(message.role === 'assistant' && !message.content && !(message.agentSteps?.length))
    );
    const nextMessages = [...cleanedPrior, userMessage];
    const evidenceOffset = maxEvidenceNumber(cleanedPrior);
    setMessages([...cleanedPrior, userMessage, assistantMessage]);
    if (!isQueuedSend) {
      setQuestion('');
      questionRef.current = '';
      if (!isResend) {
        const sentClientIds = new Set(readyPending.map((attachment) => attachment.clientId));
        setPendingAttachmentState((current) => current.filter((attachment) => !sentClientIds.has(attachment.clientId)));
      }
      clearComposerDraft(currentComposerDraftKey());
    }
    setStreamingMessageId(assistantId);
    setLoading(true);
    loadingRef.current = true;
    setError('');
    setStatusDetail(isResend ? '正在重新生成…' : '正在理解问题…');
    markConversationGenerating(currentConversationId, true);
    promoteConversationByUserMessage(currentConversationId);

    let receivedChunk = false;
    let sawDone = false;
    let sawDoneAttachments = false;
    let serverAcceptedTurn = false;
    let streamHandoff: 'resume' | 'complete' | null = null;

    try {
      const response = await fetch(apiBaseForKind(outgoingKind), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: trimmed,
          messages: nextMessages,
          conversationId: currentConversationId || undefined,
          userMessageId: userMessage.id,
          assistantMessageId: assistantId,
          attachmentIds: messageAttachments.map((attachment) => attachment.id),
          evidenceOffset,
          mode: 'agent',
          depth: 'deep',
          reasoningEffort: 'high',
          smallThinking: reasoningTier.smallThinking,
          thinkingId: reasoningTier.thinkingId,
          chatModel: pickerModel,
          modelRole: config.fixedModelRole || endpointRoleForChatModel(pickerModel),
          thunder: pickerModel === 'thunder',
          reasoningRatio,
          enableChartGeneration: composerToolRef.current === 'chart-generation',
          composerTool: composerToolRef.current || undefined,
          queueItemId: options?.queueItemId,
          ...(options?.truncateFromMessageId
            ? {
                truncateFromMessageId: options.truncateFromMessageId,
                truncateKeepCount: options.truncateKeepCount ?? 0
              }
            : {})
        }),
        signal: controller.signal
      });
      if (userIdAtStart !== authUserIdRef.current) return;

      if (!response.ok) {
        const text = await response.text();
        if (userIdAtStart !== authUserIdRef.current) return;
        let data: { error?: string };
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(text.startsWith('<!DOCTYPE') ? '服务端返回了 HTML 错误页，请查看终端日志。' : text || '查询失败');
        }
        if (response.status === 409 && currentConversationId) {
          if (!options?.queueItemId) {
            try {
              await enqueueSendTurn({
                conversationId: currentConversationId,
                question: displayQuestion,
                attachments: messageAttachments
              });
            } catch (queueError) {
              throw new Error(
                queueError instanceof Error
                  ? queueError.message
                  : data.error || '当前会话正在生成，自动加入排队失败。'
              );
            }
          }
          await refreshSendQueue({ drain: false }).catch(() => undefined);
          streamHandoff = 'resume';
          markConversationGenerating(currentConversationId, true);
          if (conversationIdRef.current === currentConversationId) {
            setMessages(cleanedPrior.length ? cleanedPrior : initialMessages);
            setStreamingMessageId('');
            setStatusDetail('其它窗口正在生成，本轮已加入排队…');
            void loadConversation(currentConversationId, {
              resumeInFlight: true,
              restore: true,
              kind: outgoingKind
            });
          }
          return;
        }
        throw new Error(data.error || '查询失败');
      }

      if (options?.queueItemId) {
        setSendQueueState(
          sendQueueRef.current.filter((item) => item.id !== options.queueItemId)
        );
      }
      serverAcceptedTurn = true;

      if (!response.body) throw new Error('响应流不可用。');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const consumeLine = async (line: string) => {
        if (userIdAtStart !== authUserIdRef.current) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed) as StreamEvent;
          if (event.type === 'done') {
            sawDone = true;
            sawDoneAttachments = sawDoneAttachments || Boolean(event.attachments?.length);
          }
        } catch {
          // parseEventLine will surface JSON errors
        }
        receivedChunk = (await parseEventLine(line, assistantId, currentConversationId)) || receivedChunk;
      };

      while (true) {
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (readError) {
          throw new Error(normalizeStreamError(readError));
        }
        const { value, done } = readResult;
        if (controller.signal.aborted || userIdAtStart !== authUserIdRef.current) return;

        if (value) buffer += decoder.decode(value, { stream: !done });

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          await consumeLine(line);
          newlineIndex = buffer.indexOf('\n');
        }

        if (done) break;
      }

      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) await consumeLine(tail);
      if (userIdAtStart !== authUserIdRef.current) return;

      if (!sawDone) {
        throw new Error('网络异常，回答未完整接收（连接在完成前断开）。');
      }

      const viewing = conversationIdRef.current === currentConversationId;
      if (viewing && !receivedChunk) {
        updateMessage(assistantId, (message) => {
          const salvaged = salvageAnswerFromSteps(message.agentSteps);
          return { ...message, content: salvaged || '没有生成回答。' };
        });
      }
      if (viewing && sawDone && !sawDoneAttachments) {
        await recoverDeliveredAttachments(
          currentConversationId,
          assistantId,
          outgoingKind
        );
      }
      void ensureConversationTitle(currentConversationId, displayQuestion);
      await loadConversations({ bypassCache: true });
      if (conversationIdRef.current === currentConversationId) setStatusDetail('');
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = normalizeStreamError(err);
      if (isNetworkDisconnectError(err) || isNetworkDisconnectError(message)) {
        try {
          const probed = await fetchConversationRunState(
            apiBaseForKind(outgoingKind),
            currentConversationId
          );
          if (probed) {
            const mapped = mapLoadedMessages(probed.messages as ChatMessage[]);
            const outcome = classifyDisconnectedChatRun({
              generating: probed.generating,
              messages: mapped
            });
            if (outcome === 'resume') {
              streamHandoff = 'resume';
              if (conversationIdRef.current === currentConversationId) {
                if (mapped.length) setMessages(mapped);
                setError('');
                setStatusDetail('实时连接已中断，正在从服务端继续同步进度…');
                markConversationGenerating(currentConversationId, true);
                resumeInFlightIfNeeded(mapped, currentConversationId, true);
              }
              return;
            }
            if (outcome === 'complete') {
              streamHandoff = 'complete';
              if (conversationIdRef.current === currentConversationId) {
                if (mapped.length) setMessages(mapped);
                setError('');
                setStatusDetail('');
                if (!sawDoneAttachments) {
                  await recoverDeliveredAttachments(
                    currentConversationId,
                    assistantId,
                    outgoingKind
                  );
                }
                void ensureConversationTitle(currentConversationId, displayQuestion);
                await loadConversations({ bypassCache: true });
              }
              return;
            }
          }
        } catch {
          // fall through to the visible error
        }
      }
      if (conversationIdRef.current === currentConversationId) {
        setError(message);
        setStatusDetail(isNetworkDisconnectError(message) ? '连接中断' : '查询失败');
        updateMessage(assistantId, (current) => {
          const salvaged = current.content?.trim()
            ? current.content
            : salvageAnswerFromSteps(current.agentSteps);
          const suffix = `\n\n抱歉，查询失败：${message}`;
          return {
            ...current,
            content: salvaged ? `${salvaged}${suffix}` : `抱歉，查询失败：${message}`,
            thinkingDurationMs: freezeThinkingDurationMs(current)
          };
        });
      }
    } finally {
      const stillThisRun = liveRunsRef.current.get(currentConversationId)?.controller === controller;
      if (stillThisRun) {
        liveRunsRef.current.delete(currentConversationId);
        if (streamHandoff === 'resume') {
          markConversationGenerating(currentConversationId, true);
        } else {
          markConversationGenerating(currentConversationId, false);
          if (controller.signal.aborted) {
            skipCompletedNoticeRef.current.add(currentConversationId);
          } else {
            noteGenerationSettled(currentConversationId);
          }
        }
      }
      const viewingNow = conversationIdRef.current === currentConversationId;
      if (viewingNow && (stillThisRun || controllerRef.current === controller)) {
        if (streamHandoff !== 'resume') {
          updateMessage(assistantId, (message) => ({
            ...message,
            inProgress: false,
            thinkingDurationMs: freezeThinkingDurationMs(message)
          }));
          setLoading(false);
          loadingRef.current = false;
          setStreamingMessageId('');
        }
      }
      if (controllerRef.current === controller) controllerRef.current = null;
      if (
        streamHandoff !== 'resume'
        && (!isQueuedSend || serverAcceptedTurn)
        && conversationIdRef.current === currentConversationId
        && (stillThisRun || options?.force)
        && !hasLocalRun(currentConversationId)
      ) {
        scheduleDrainSendQueue(currentConversationId);
      }
    }
  }

  const visibleMessages = messages.filter((message) => message.id !== 'welcome');
  const settingsLocked = visibleMessages.length > 0;
  conversationStartedRef.current = settingsLocked;
  const latestContextUsage = [...visibleMessages]
    .reverse()
    .find((message) => message.role === 'assistant' && hasRecognizedContextUsage(message.contextUsage))
    ?.contextUsage;
  const activeModelRole = config.fixedModelRole || endpointRoleForChatModel(pickerModel);
  const researchReviewMode = composerTool === 'research-review' || conversationKind === 'research-review';
  const chartGenerationMode = composerTool === 'chart-generation';
  const patentMode = composerTool === 'patent';
  const composerExpanded = Boolean(composerTool);

  useLayoutEffect(() => {
    if (patentMode || !listReady) return;
    questionInputRef.current?.focus({ preventScroll: true });
  }, [patentMode, listReady]);

  useLayoutEffect(() => {
    const el = questionInputRef.current;
    if (!el) return;
    const sync = () => {
      const lines = syncComposerTextareaHeight(el);
      setComposerLineCount((current) => (current === lines ? current : lines));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [question, composerExpanded, composerToolsEnabled]);
  const { attachments: conversationAttachments, artifacts: conversationArtifacts } = useMemo(
    () => collectAssistantDeliveredFiles(messages),
    [messages]
  );
  const visibleQueue = useMemo(
    () => sendQueue.filter((item) => item.conversationId === conversationId),
    [sendQueue, conversationId]
  );
  const sidePlugins = useMemo<ChatSidePlugin[]>(() => {
    const plugins: ChatSidePlugin[] = [];
    if (visibleQueue.length) {
      plugins.push({
        id: QUEUE_SIDE_PLUGIN_ID,
        label: '发送排队',
        icon: ListOrdered,
        badge: visibleQueue.length,
        content: (
          <ChatQueuePluginPanel
            items={visibleQueue}
            onSendNow={sendQueuedNow}
            onRemove={removeQueuedTurn}
          />
        )
      });
    }
    if (conversationAttachments.length || conversationArtifacts.length) {
      plugins.push({
        id: ATTACHMENT_SIDE_PLUGIN_ID,
        label: '附件查看',
        icon: Paperclip,
        badge: conversationAttachments.length + conversationArtifacts.length,
        content: (
          <ChatAttachmentPluginPanel
            attachments={conversationAttachments}
            artifacts={conversationArtifacts}
            onPreview={setModalAttachment}
            onDownloadAttachment={(attachment) => void downloadConversationAttachment(attachment)}
            onDownloadArtifact={(artifact) => void downloadResearchArtifact(artifact as ResearchReviewArtifact)}
          />
        )
      });
    }
    if (!researchReviewMode && knowledgeSources.length) {
      plugins.push({
        id: KNOWLEDGE_SIDE_PLUGIN_ID,
        label: '知识库链接',
        icon: Link2,
        badge: knowledgeSources.length,
        content: (
          <ChatKnowledgePluginPanel
            items={knowledgeSources.map((source) => ({
              key: source.id || source.sourceKey || source.title,
              citation: citationLabel(source),
              kind: isLinkSource(source) ? 'link' : (source.fileKind || source.sourceType || ''),
              title: chipLabel(source),
              snippet: source.snippet,
              matchReason: source.matchReason,
              isLink: isLinkSource(source)
            }))}
            onOpen={(key) => {
              const source = knowledgeSources.find((item) =>
                (item.id || item.sourceKey || item.title) === key
              );
              if (!source) return;
              if (isLinkSource(source)) {
                const url = linkSourceUrl(source);
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
                return;
              }
              setModalSource(source);
            }}
            onOpenGraph={() => setKnowledgeGraphOpen(true)}
          />
        )
      });
    }
    return plugins;
  }, [
    conversationAttachments,
    conversationArtifacts,
    knowledgeSources,
    researchReviewMode,
    visibleQueue
  ]);
  const sidePluginAvailable = sidePlugins.length > 0;
  const attachmentPluginCount = conversationAttachments.length + conversationArtifacts.length;
  const queueCount = visibleQueue.length;

  useEffect(() => {
    if (!sidePluginAvailable) {
      setSidePluginOpen(false);
      return;
    }
    setSidePluginOpen(true);
    setSidePluginId((current) => {
      if (current === QUEUE_SIDE_PLUGIN_ID && queueCount) return current;
      if (current === ATTACHMENT_SIDE_PLUGIN_ID && attachmentPluginCount) return current;
      if (current === KNOWLEDGE_SIDE_PLUGIN_ID && knowledgeSources.length) return current;
      if (queueCount) return QUEUE_SIDE_PLUGIN_ID;
      if (attachmentPluginCount) return ATTACHMENT_SIDE_PLUGIN_ID;
      if (knowledgeSources.length) return KNOWLEDGE_SIDE_PLUGIN_ID;
      return current;
    });
  }, [conversationId, sidePluginAvailable, attachmentPluginCount, knowledgeSources.length, queueCount]);

  const attachmentUploadBusy = pendingAttachments.some((attachment) =>
    ['queued', 'uploading', 'processing', 'removing'].includes(attachment.status)
  );
  const readyPendingAttachments = pendingAttachments.filter(isLocalReadyPending);
  const canSend = !attachmentUploadBusy
    && (Boolean(question.trim()) || readyPendingAttachments.length > 0);
  const filteredConversations = conversations.filter((conversation) => {
    if (!convSearch.trim()) return true;
    return conversation.title.toLowerCase().includes(convSearch.trim().toLowerCase());
  });

  return (
    <div
      ref={layoutRef}
      className="rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4"
      onDragEnter={patentMode ? undefined : handleFileDragEnter}
      onDragOver={patentMode ? undefined : handleFileDragOver}
      onDragLeave={patentMode ? undefined : handleFileDragLeave}
      onDrop={patentMode ? undefined : handleFileDrop}
    >
      {!patentMode && draggingFiles ? (
        <div className="pointer-events-none absolute inset-3 z-[250] flex items-center justify-center rounded-xl border-2 border-dashed border-primary/40 bg-muted/90 text-foreground shadow-soft backdrop-blur-sm" role="status" aria-live="polite">
          <div className="flex flex-col items-center gap-2">
            <Paperclip className="h-7 w-7" />
            <span className="text-sm font-semibold">释放以上传附件</span>
            <span className="text-xs text-muted-foreground">{attachmentHint}</span>
          </div>
        </div>
      ) : null}

      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">{config.kicker}</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">{config.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{config.subtitle}</p>
      </div>

      {patentMode ? (
        <PatentWorkbench
          embedded
          composerTool="patent"
          onSelectComposerTool={selectComposerTool}
        />
      ) : (
      <div className="rag-chat-card min-h-0 flex-1">
        {/* Conversation list */}
         <aside className={`rag-conv-list ${historyOpen ? 'flex' : 'hidden md:flex'}`}>
          <div className="shrink-0 space-y-3 border-b border-border p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={convSearch}
                onChange={(event) => setConvSearch(event.target.value)}
                placeholder="搜索会话..."
                className="ui-input h-9 pl-9"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                startNewConversation();
                setHistoryOpen(false);
              }}
              className="ui-btn-primary h-9 w-full gap-1.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              新对话
            </button>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
            {!listReady ? (
              <div className="px-1 py-2" aria-busy="true" aria-label="正在加载会话" />
            ) : filteredConversations.length ? (
              <div className={`space-y-0.5 ${listEntering ? 'rag-conv-list-enter' : ''}`}>
                {filteredConversations.map((conversation, index) => {
                  const active = conversation.id === conversationId;
                  return (
                    <div
                      key={conversation.id}
                      className={`group relative ${active ? 'rag-conv-item rag-conv-item-active' : 'rag-conv-item'}`}
                      style={{ '--rag-conv-i': Math.min(index, 12) } as CSSProperties}
                    >
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => {
                            void loadConversation(conversation.id);
                            setHistoryOpen(false);
                          }}
                          className="w-full text-left"
                        >
                          <div className="flex items-start justify-between gap-2">
                              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                              {conversation.kind === 'research-review' ? (
                                <span className="shrink-0 rounded bg-primary/10 px-1 py-px text-[10px] font-semibold text-primary">综述</span>
                              ) : null}
                              {generatingIds.has(conversation.id) ? (
                                <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-label="生成中" />
                              ) : unreadCompletedIds.has(conversation.id) ? (
                                <span
                                  className="h-2 w-2 shrink-0 rounded-full bg-sky-400"
                                  title="有新消息已完成"
                                  aria-label="有新消息已完成"
                                />
                              ) : null}
                              <span className="min-w-0 truncate text-sm font-medium leading-5 text-foreground">{conversation.title}</span>
                            </span>
                            <span className="shrink-0 pt-0.5 text-[10px] leading-4 text-muted-foreground">{formatTime(conversation.last_user_at || conversation.created_at)}</span>
                          </div>
                        </button>
                        <div className="mt-0.5 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void loadConversation(conversation.id);
                              setHistoryOpen(false);
                            }}
                            className="min-w-0 flex-1 truncate text-left text-xs leading-4 text-muted-foreground"
                          >
                            {conversation.messageCount ? `${conversation.messageCount} 条消息` : '点击打开会话'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteConversation(conversation.id)}
                            className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
                            aria-label="删除会话"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-full min-h-48 flex-col items-center justify-center px-4 text-center">
                <MessageSquare className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />
                <p className="mt-3 text-sm font-medium text-foreground">暂无会话</p>
                <p className="mt-1 text-xs text-muted-foreground">开始提问后会显示在这里</p>
              </div>
            )}
          </div>
        </aside>

        {/* Main chat pane */}
         <main className={`min-h-0 min-w-0 flex-1 flex-col ${historyOpen ? 'hidden md:flex' : 'flex'}`}>
          <SubagentSheetHostContext.Provider value={subagentSheetHost}>
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent md:hidden"
              aria-label="打开会话列表"
            >
              <MessageSquare className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{conversationTitle || '新会话'}</div>
              <div className="truncate text-xs text-muted-foreground">
                {loading && pendingChatAskRequests(
                  messages.find((message) => message.id === streamingMessageId)?.agentSteps || []
                ).length
                  ? '等待你确认选项…'
                  : loading && statusDetail
                  ? statusDetail.replace(/\s*ses_[A-Za-z0-9]+/g, '').replace(/能元会话/g, '').trim() || '对话进行中'
                  : researchReviewMode
                    ? '科研传承助手'
                    : chartGenerationMode
                      ? '主动生成数据图'
                      : loading
                      ? '对话进行中'
                      : visibleMessages.length
                        ? '对话已就绪'
                        : '选择或开始一场对话'}
              </div>
            </div>
            <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" onClick={() => setPowerOpen(true)}>电力计算</button>
            <PowerTaskIndicator />
            <div className="rag-reasoning-cluster">
              <ChatModelMenu
                value={pickerModel}
                disabled={settingsLocked}
                hideModelList={Boolean(config.fixedModelRole)}
                reasoningRatio={reasoningRatio}
                thinkingLevels={thinkingLevels}
                thinkingLocked={settingsLocked}
                thinkingLockedTitle={settingsLocked ? '对话已开始，不能调整思考强度' : undefined}
                onModelChange={(next) => {
                  if (settingsLocked) return;
                  setChatModel(next);
                  setReasoningRatio(defaultChatThinkingRatio(next));
                  persistConversationChatModel(next);
                }}
                onReasoningChange={(next) => {
                  if (settingsLocked) return;
                  setReasoningRatio(snapChatReasoningRatio(next, thinkingLevels));
                }}
              />
            </div>
            <ContextUsageIndicator
              usage={latestContextUsage}
              modelRole={activeModelRole}
              conversationId={conversationId}
              conversationKind={researchReviewMode ? 'research-review' : (config.conversationKind || 'chat')}
            />
          </header>

          <div className="relative min-h-0 flex-1">
          {powerOpen ? <div className="absolute inset-0 z-40 flex justify-end bg-background/50" role="dialog" aria-modal="true" aria-label="电力计算参数确认" onKeyDown={event => { if (event.key === 'Escape') setPowerOpen(false); }}>
            <div className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-background shadow-xl">
              <header className="flex shrink-0 justify-between border-b border-border p-4 text-sm"><strong>电力计算</strong><button onClick={() => setPowerOpen(false)} aria-label="关闭电力计算">关闭</button></header>
              <div className="min-h-0 flex-1 overflow-y-auto"><PowerComputePanel onUseResult={text => { setQuestion(text); setPowerOpen(false); }}/></div>
            </div>
          </div> : null}
          <StickToBottomFrame
            className="scrollbar-visible px-4 py-4"
            wrapperClassName="h-full"
            contentClassName={!visibleMessages.length ? 'items-center justify-center' : undefined}
            followKey={scrollFingerprint}
            resetKey={stickResetKey}
          >
            {!visibleMessages.length ? (
              <div className="flex min-h-full w-full flex-1 flex-col items-center justify-center text-center">
                <WelcomeTypewriter
                  key={welcomeKey}
                  text={welcomeLine}
                  ready={!statsLoading}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {visibleMessages.map((message, messageIndex) => {
                  const isStreamingMsg = loading && message.id === streamingMessageId;
                  const isLast = messageIndex === visibleMessages.length - 1;
                  const hasPreviousUser = visibleMessages
                    .slice(0, messageIndex)
                    .some((item) => item.role === 'user');
                  const canResend = message.role === 'user' || hasPreviousUser;
                  return (
                  <div
                    key={message.id}
                    className={`group/msg flex w-full ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`flex flex-col ${message.role === 'user' ? 'max-w-[75%] items-end' : 'w-full max-w-[90%] items-start'}`}>
                      <div
                        className={
                          message.role === 'user'
                            ? 'rag-user-bubble'
                            : 'rag-assistant-bubble'
                        }
                      >
                        {message.role === 'assistant' ? (
                          <>
                            {(() => {
                              const allSteps = message.agentSteps || [];
                              const pendingAsks = pendingChatAskRequests(allSteps);
                              const live = Boolean(isStreamingMsg && (!message.content || pendingAsks.length));
                              const process = (
                                <AssistantAgentProcess
                                  allSteps={allSteps}
                                  live={live}
                                  running={isStreamingMsg && !isPositiveMs(message.thinkingDurationMs)}
                                  progressItems={isStreamingMsg ? reproProgressItems : undefined}
                                  status={pendingAsks.length ? '等待你确认选项…' : statusDetail}
                                  answerContent={message.content}
                                  sources={assistantMessageSources(message)}
                                  onCitationClick={openCitation}
                                  onReplyAsk={pendingAsks.length ? replyChatAsk : undefined}
                                />
                              );
                              if (live) {
                                return process;
                              }
                              return (
                                <>
                                  {process}
                                   {message.content ? (
                                     <div className="mt-1 min-w-0">
                                       <MessageContent
                                         content={message.content}
                                         streaming={isStreamingMsg}
                                         sources={assistantMessageSources(message)}
                                         onCitationClick={openCitation}
                                       />
                                    </div>
                                  ) : !(message.agentSteps?.length) ? (
                                    <TypingIndicator />
                                  ) : null}
                                </>
                              );
                            })()}
                            <CollapsibleReferences
                              sources={assistantMessageSources(message)}
                              onSourceClick={(source) => {
                                if (isLinkSource(source)) {
                                  const url = linkSourceUrl(source);
                                  if (url) window.open(url, '_blank', 'noopener,noreferrer');
                                  return;
                                }
                                setModalSource(source);
                              }}
                            />
                          </>
                        ) : (
                          <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
                        )}
                        {message.attachments?.length ? (
                          <>
                            {(message.attachments || []).some(isImageAttachment) ? (
                              <div className="mt-2 grid gap-2">
                                {(message.attachments || []).filter(isImageAttachment).map((attachment) => (
                                  <button
                                    key={attachment.id}
                                    type="button"
                                    onClick={() => setModalAttachment(attachment)}
                                    className={`overflow-hidden rounded-lg border text-left ${
                                      message.role === 'user'
                                        ? 'border-primary-foreground/20 bg-primary-foreground/10'
                                        : 'border-border bg-white'
                                    }`}
                                  >
                                    <img
                                      src={attachment.previewUrl}
                                      alt={attachment.name}
                                      className="max-h-72 w-full bg-white object-contain"
                                    />
                                    <span className={`block truncate px-2 py-1 text-[11px] ${
                                      message.role === 'user' ? 'text-primary-foreground/70' : 'text-muted-foreground'
                                    }`}>{attachment.name}</span>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            <CompactMessageAttachments
                              attachments={message.attachments || []}
                              inverted={message.role === 'user'}
                              onOpen={setModalAttachment}
                            />
                          </>
                        ) : null}
                      </div>
                      <div className={`rag-msg-meta${message.role === 'user' ? ' rag-msg-meta-end' : ''}`}>
                        {message.role === 'assistant' ? (
                          <>
                            <ChatTurnClock
                              running={isStreamingMsg && !isPositiveMs(message.thinkingDurationMs)}
                              durationMs={message.thinkingDurationMs}
                              startedAt={message.startedAt}
                              createdAt={message.createdAt}
                              previousCreatedAt={previousUserCreatedAt(visibleMessages, messageIndex)}
                            />
                            {formatModelTierLabel(message.chatModel, message.thinkingId) ? (
                              <span className="rag-msg-model-tier">
                                {formatModelTierLabel(message.chatModel, message.thinkingId)}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                        {!isStreamingMsg ? (
                          <ChatMessageActions
                            align={message.role}
                            alwaysVisible={isLast}
                            canResend={canResend}
                            disabled={historyEditing || !conversationId}
                            onRevert={() => revertFromMessage(message.id)}
                            onResend={canResend ? () => resendFromMessage(message.id) : undefined}
                            onDelete={() => deleteMessageRecord(message.id)}
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
            )}
          </StickToBottomFrame>
          <div ref={setSubagentSheetHost} className="pointer-events-none absolute inset-0 z-30 overflow-hidden" />
          </div>

          <form onSubmit={ask} className="shrink-0 border-t border-border px-4 py-3">
            <input
              ref={fileInputRef}
              type="file"
              accept={attachmentAccept}
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => {
                if (event.currentTarget.files) addAttachmentFiles(event.currentTarget.files);
                event.currentTarget.value = '';
              }}
            />
            {pendingAttachments.length ? (
              <>
                {pendingAttachments.some(isPendingImage) ? (
                  <div className="mb-1.5 flex gap-1.5 overflow-x-auto">
                    {pendingAttachments.filter(isPendingImage).map((attachment) => (
                      <PendingImageThumb
                        key={attachment.clientId}
                        pending={attachment}
                        onOpen={(key) => {
                          const pending = pendingAttachments.find((item) => item.clientId === key);
                          if (pending?.attachment?.status === 'ready') setModalAttachment(pending.attachment);
                        }}
                        onRemove={removePendingAttachment}
                      />
                    ))}
                  </div>
                ) : null}
                <CompactPendingAttachments
                items={pendingAttachments.map((attachment) => ({
                  key: attachment.clientId,
                  name: attachment.name,
                  size: attachment.size,
                  extension: attachment.extension,
                  mediaType: attachment.mediaType,
                  statusLabel: pendingAttachmentStatusLabel(attachment),
                  typeLabel: attachmentTypeLabel(attachment),
                  ready: attachment.status === 'ready',
                  failed: attachment.status === 'failed',
                  busy: ['queued', 'uploading', 'processing', 'removing'].includes(attachment.status),
                  progress: attachment.progress,
                  error: attachment.error,
                  canRemove: attachment.status !== 'removing'
                }))}
                onOpen={(key) => {
                  const pending = pendingAttachments.find((item) => item.clientId === key);
                  if (pending?.attachment?.status === 'ready') setModalAttachment(pending.attachment);
                }}
                onRemove={removePendingAttachment}
                onOpenAll={() => setPendingManagerOpen(true)}
                footer={
                  readyPendingAttachments.length && !question.trim() ? (
                    <p className="px-0.5 text-[10px] text-muted-foreground">
                      未输入问题时将发送“{researchReviewMode ? RESEARCH_REVIEW_ATTACHMENT_ONLY_QUESTION : ATTACHMENT_ONLY_QUESTION}”
                    </p>
                  ) : null
                }
              />
              </>
            ) : null}

            <div className="flex items-end gap-2">
              {composerToolsEnabled ? (
                <div
                  className="relative min-h-12 min-w-0 flex-1 rounded-2xl border border-input bg-background shadow-sm focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50"
                >
                  <div className={`flex gap-1 px-1.5 pt-1.5 ${
                    composerExpanded
                      ? 'items-start pb-1'
                      : composerLineCount > 1
                        ? 'items-end pb-1.5'
                        : 'items-center pb-1.5'
                  }`}>
                    <ChatComposerToolMenu
                      selectedTool={composerTool}
                      onSelect={selectComposerTool}
                    />
                    <textarea
                      ref={questionInputRef}
                      autoFocus
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          ask();
                        }
                      }}
                      placeholder={
                        researchReviewMode
                          ? '描述综述主题，或上传文献后发送…'
                          : chartGenerationMode
                            ? '描述要画的数据，或上传表格后发送…'
                            : '输入问题，或粘贴文件、图片作为附件…'
                      }
                      rows={1}
                      className="h-8 min-h-8 min-w-0 flex-1 resize-none overflow-hidden bg-transparent px-1 py-1.5 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={pendingAttachments.length >= MAX_ATTACHMENT_FILES}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="添加附件"
                      title={`添加附件（${attachmentHint}）`}
                    >
                      <Paperclip className="h-4 w-4" />
                    </button>
                  </div>
                  <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                    composerExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}>
                    <div className={`overflow-hidden ${composerExpanded ? '' : 'pointer-events-none'}`}>
                      {composerExpanded ? (
                        <div className="flex flex-wrap items-center gap-1.5 px-1.5 pb-2">
                          {composerTool ? (
                            <ComposerToolChip tool={composerTool} onClear={() => selectComposerTool(null)} />
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
              {loading ? (
                <div className="mb-0.5 flex items-center gap-1.5">
                  {canSend ? (
                    <button
                      type="submit"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90"
                      aria-label="加入排队"
                      title="当前正在生成，发送后会加入排队"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={stopGeneration}
                    className="inline-flex h-8 items-center gap-1 rounded-md bg-destructive/10 px-3 text-xs font-medium text-destructive transition hover:bg-destructive/15"
                    aria-label="停止生成"
                  >
                    <Square className="h-2.5 w-2.5 fill-current" />
                    停止
                  </button>
                </div>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend}
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={question.trim() ? '发送问题' : '发送附件并使用默认问题'}
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </form>
          </SubagentSheetHostContext.Provider>
        </main>

        {sidePluginAvailable ? (
          <ChatSidePluginRail
            plugins={sidePlugins}
            open={sidePluginOpen}
            activeId={sidePluginId}
            onOpenChange={setSidePluginOpen}
            onActiveIdChange={setSidePluginId}
          />
        ) : null}
      </div>
      )}

      {modalSource ? <EvidenceModal source={modalSource} onClose={() => setModalSource(null)} /> : null}
      {modalAttachment ? <AttachmentPreviewModal attachment={modalAttachment} onClose={() => setModalAttachment(null)} /> : null}
      {pendingManagerOpen ? (
        <CompactAttachmentManagerModal
          title="待发送附件"
          items={pendingAttachments.map((attachment) => ({
            key: attachment.clientId,
            name: attachment.name,
            size: attachment.size,
            statusLabel: pendingAttachmentStatusLabel(attachment),
            typeLabel: attachmentTypeLabel(attachment),
            ready: attachment.status === 'ready',
            failed: attachment.status === 'failed',
            busy: ['queued', 'uploading', 'processing', 'removing'].includes(attachment.status),
            progress: attachment.progress,
            error: attachment.error,
            canRemove: attachment.status !== 'removing'
          }))}
          onClose={() => setPendingManagerOpen(false)}
          onPreview={(key) => {
            const pending = pendingAttachments.find((item) => item.clientId === key);
            if (pending?.attachment?.status === 'ready') {
              setPendingManagerOpen(false);
              setModalAttachment(pending.attachment);
            }
          }}
          onRemove={(key) => removePendingAttachment(key)}
        />
      ) : null}
      {knowledgeGraphOpen ? <KnowledgeGraphModal seedIds={conversationGraphSeedIds} onClose={() => setKnowledgeGraphOpen(false)} /> : null}
    </div>
  );
}
