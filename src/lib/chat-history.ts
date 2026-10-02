import { all, get, run, withTransaction } from './db';
import { sortConversationsByLastUser } from './chat-conversation-list';
import { compactContextUsage } from './opencode/context-usage';
import { sanitizePersistedAgentSteps } from './opencode/persisted-agent-steps';
import type { ModelContextUsage, RuntimeAgentStep } from './opencode/types';
import {
  deleteConversationAttachments,
  listChatAttachmentBindings,
  type ChatAttachment
} from './chat-attachments';
import { removeChatWorkspace } from './chat-workspace-retention';
import { deleteOpenCodeSessionMapping } from './opencode/runtime';
import { RESEARCH_REVIEW_SESSION_MAP } from './research-review/constants';
import { DEFAULT_REASONING_RATIO, parseChatThunder } from './reasoning-tier';
import { normalizeChatModelId, parseChatModelId, type ChatModelId } from './model-ids';
import { lockConversationQueueMutation } from './chat-run-registry';
import { normalizeSkillIds } from './shared-skills';
import {
  deleteResearchReviewArtifacts,
  listResearchReviewArtifactsByMessages,
  type ResearchReviewArtifact
} from './research-review/artifacts';

export type ConversationKind = 'chat' | 'research-review';

export type ConversationTitleScope = {
  userId: string;
  kind: ConversationKind;
};

export type ChatConversationRow = {
  id: string;
  title: string;
  user_id: string | null;
  reasoning_ratio: number | null;
  thunder: boolean;
  /** 本会话使用的模型（arc / thunder / storm）；对话开始后锁定。 */
  chat_model: ChatModelId;
  kind: ConversationKind;
  /** 仅用于记住本会话是否开启「主动生成数据图」；技能库技能由 agent 按需加载。 */
  skill_ids_json: string | null;
  skillIds: string[];
  created_at: string;
  updated_at: string;
  last_user_at?: string;
};

const CONVERSATION_COLUMNS = `id, title, user_id, reasoning_ratio, COALESCE(thunder, 0) AS thunder, COALESCE(chat_model, CASE WHEN COALESCE(thunder, 0) = 1 THEN 'thunder' ELSE 'arc' END) AS chat_model, COALESCE(kind, 'chat') AS kind, skill_ids_json, created_at, updated_at`;

type ConversationQueryRow = Omit<ChatConversationRow, 'skillIds' | 'thunder' | 'chat_model'> & {
  skill_ids_json?: string | null;
  thunder?: unknown;
  chat_model?: unknown;
};

function mapConversationRow(row: ConversationQueryRow): ChatConversationRow {
  const thunder = parseChatThunder(row.thunder);
  return {
    ...row,
    thunder,
    chat_model: normalizeChatModelId(row.chat_model, thunder ? 'thunder' : 'arc'),
    skill_ids_json: row.skill_ids_json ?? null,
    skillIds: normalizeSkillIds(row.skill_ids_json)
  };
}

function normalizeConversationKind(value: unknown): ConversationKind {
  if (value === 'research-review') return 'research-review';
  return 'chat';
}

export function normalizeConversationReasoningRatio(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_REASONING_RATIO;
  return Math.min(1, Math.max(0, n));
}

export type ChatMessageRow = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  sources_json: string | null;
  graph_seed_ids_json: string | null;
  agent_steps_json: string | null;
  created_at: string;
};

export type ChatSource = {
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
  evidenceIds?: string[];
};

export type ChatHistoryMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
  artifacts?: ResearchReviewArtifact[];
  sources?: ChatSource[];
  graphSeedIds?: string[];
  agentSteps?: RuntimeAgentStep[];
  thinkingDurationMs?: number;
  contextUsage?: ModelContextUsage;
  inProgress?: boolean;
  /** 生成这条回答时用的模型与思考档（用于历史回显） */
  chatModel?: ChatModelId;
  thinkingId?: string;
  createdAt: string;
};

type AgentStepsPayload = {
  v: 1;
  thinkingDurationMs?: number;
  contextUsage?: ModelContextUsage;
  inProgress?: boolean;
  model?: string;
  thinking?: string;
  steps: RuntimeAgentStep[];
};

type AgentStepsInput = {
  agentSteps?: RuntimeAgentStep[];
  thinkingDurationMs?: number;
  contextUsage?: ModelContextUsage;
  inProgress?: boolean;
  chatModel?: ChatModelId;
  thinkingId?: string;
};

export function publicRuntimeAgentSteps(steps?: RuntimeAgentStep[]) {
  return sanitizePersistedAgentSteps(steps);
}

function serializeAgentSteps(input: AgentStepsInput) {
  const publicSteps = publicRuntimeAgentSteps(input.agentSteps);
  const thinkingId = String(input.thinkingId || '').trim().toLowerCase();
  if (
    !publicSteps.length
    && input.thinkingDurationMs == null
    && !input.contextUsage
    && !input.inProgress
    && !input.chatModel
    && !thinkingId
  ) {
    return null;
  }
  const payload: AgentStepsPayload = {
    v: 1,
    steps: publicSteps,
    ...(input.thinkingDurationMs != null ? { thinkingDurationMs: input.thinkingDurationMs } : {}),
    ...(compactContextUsage(input.contextUsage)
      ? { contextUsage: compactContextUsage(input.contextUsage) }
      : {}),
    ...(input.inProgress ? { inProgress: true } : {}),
    ...(input.chatModel ? { model: input.chatModel } : {}),
    ...(thinkingId ? { thinking: thinkingId } : {})
  };
  return JSON.stringify(payload);
}

function parseAgentSteps(raw: string | null): {
  steps?: RuntimeAgentStep[];
  thinkingDurationMs?: number;
  contextUsage?: ModelContextUsage;
  inProgress?: boolean;
  chatModel?: ChatModelId;
  thinkingId?: string;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return { steps: publicRuntimeAgentSteps(parsed as RuntimeAgentStep[]) };
    }
    if (
      parsed
      && typeof parsed === 'object'
      && Array.isArray((parsed as AgentStepsPayload).steps)
    ) {
      const payload = parsed as AgentStepsPayload;
      const thinking = String(payload.thinking || '').trim().toLowerCase();
      return {
        steps: publicRuntimeAgentSteps(payload.steps),
        thinkingDurationMs: typeof payload.thinkingDurationMs === 'number'
          ? payload.thinkingDurationMs
          : undefined,
        contextUsage: compactContextUsage(payload.contextUsage),
        inProgress: payload.inProgress === true,
        chatModel: parseChatModelId(payload.model) || undefined,
        thinkingId: thinking || undefined
      };
    }
  } catch {
    return {};
  }
  return {};
}

export const CONVERSATION_TITLE_MAX_CHARS = 28;
/** 尚未由模型总结命名前的默认会话名。 */
export const DEFAULT_CONVERSATION_TITLE = '新会话';

function normalizeTitleWhitespace(text: string) {
  let normalized = String(text || '').replace(/\s+/g, ' ').trim();
  // Chinese titles read better without spaces between Han characters, while
  // spaces inside English names and file/function names remain meaningful.
  for (let pass = 0; pass < 3; pass += 1) {
    normalized = normalized.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/gu, '$1');
  }
  return normalized.replace(/\s+([，。！？；：、,.!?;:])/gu, '$1');
}

function clipTitle(text: string, max = CONVERSATION_TITLE_MAX_CHARS) {
  const normalized = normalizeTitleWhitespace(text);
  if (!normalized) return '';
  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;

  // Prefer a word boundary for Latin titles, then avoid ending a Chinese
  // title on a connective or structural particle.
  const wordBoundary = normalized.slice(0, max + 1).lastIndexOf(' ');
  if (wordBoundary >= 8) return normalized.slice(0, wordBoundary).trim();

  const softEndings = new Set('的了吗呢啊呀么与和及对在于从把被给'.split(''));
  let cut = max;
  for (let i = max; i >= Math.min(8, max); i -= 1) {
    if (!softEndings.has(chars[i - 1] || '')) {
      cut = i;
      break;
    }
  }
  return normalizeTitleWhitespace(chars.slice(0, cut).join(''))
    .replace(/[，。！？；：、,.!?;:]+$/u, '');
}

export function isDefaultConversationTitle(title?: string | null) {
  const compact = normalizeTitleWhitespace(String(title || ''));
  return !compact || compact === DEFAULT_CONVERSATION_TITLE || compact === '新对话';
}

function stripQuestionPreamble(text: string) {
  let title = normalizeTitleWhitespace(text)
    .replace(/^```(?:[a-z0-9_-]+)?\s*/iu, '')
    .replace(/```$/u, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, '')
    .replace(/^(?:用户问题|问题|需求|任务)\s*[:：]\s*/u, '');

  // Keep the action and subject, but remove conversational politeness and
  // English prompt wrappers that make sidebar titles feel like raw prompts.
  for (let pass = 0; pass < 3; pass += 1) {
    title = title
      .replace(/^(?:请问|请你|请|麻烦|劳驾|帮我|帮助我|帮忙|能不能|可不可以|能否|可否|我想要|我想|我需要|希望你|给我|告诉我)[\s,，、:：]*/u, '')
      .replace(/^(?:please|could you|can you|would you|help me|i want to|i need to)\s+/iu, '');
  }

  return normalizeTitleWhitespace(title)
    .replace(/^(?:关于|有关|针对|围绕)\s*/u, '')
    .replace(/[?？!！。．.]+$/u, '')
    .replace(/[，,、:：]+$/u, '')
    .replace(/(?:[，,、\s]*(?:谢谢|感谢|辛苦了|可以吗|行吗|好吗))$/u, '')
    .replace(/(?:的(?:讨论|对话|会话|研究|总结)|相关(?:讨论|问题))$/u, '')
    .trim();
}

/** 本地规则回退：短任务名优先于把整段用户问题直接塞进标题。 */
export function summarizeConversationTitle(question: string) {
  const source = String(question || '').replace(/\r\n?/g, '\n').trim();
  if (!source) return DEFAULT_CONVERSATION_TITLE;
  const firstLine = source.split('\n').map((line) => line.trim()).find(Boolean) || source;
  const firstSentence = firstLine.split(/[。！？!?]/u)[0] || firstLine;
  const softened = stripQuestionPreamble(firstSentence);
  return clipTitle(softened || stripQuestionPreamble(source) || normalizeTitleWhitespace(source))
    || DEFAULT_CONVERSATION_TITLE;
}

function cleanGeneratedTitle(content: string) {
  let text = String(content || '')
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();

  // Some compatible endpoints ignore the one-line instruction and return a
  // tiny JSON object. Accept it without making JSON the model-facing format.
  const jsonTitle = text.match(/["']title["']\s*:\s*["']([^"']+)["']/iu)?.[1];
  if (jsonTitle) text = jsonTitle;

  const lines = text
    .split(/\r?\n/)
    .map((line) => {
      const withoutWrapper = stripQuestionPreamble(line)
        .replace(/^(?:我建议|这里是|以下是|这是(?:一个)?标题)\s*[:：]\s*/u, '')
        .replace(/^(?:here(?:'s| is)(?: the)? title|the title is|suggested title)\s*[:：-]\s*/iu, '')
        .replace(/^(?:标题(?:是)?|会话标题|建议标题|title)\s*[:：]?\s*/iu, '');
      return stripQuestionPreamble(withoutWrapper);
    })
    .filter(Boolean);
  const candidate = lines.find((line) => {
    const len = Array.from(line.replace(/\s+/g, '')).length;
    return len >= 2 && len <= 40
      && !/^(?:当然|可以|好的)[：:]?/u.test(line);
  }) || '';

  return candidate
    .replace(/^[#*\-•\s]+/u, '')
    .replace(/^(?:标题(?:是)?|会话标题|建议标题|title)\s*[:：]?\s*/iu, '')
    .replace(/^["'“”‘’「」『』【】《》]+|["'“”‘’「」『』【】《》]+$/gu, '')
    .replace(/[，。．.!！？?；;：:、]+$/u, '')
    .trim();
}

function looksLikeTemplateTitle(title: string) {
  return /^(?:关于|有关|针对|围绕).{0,18}(?:问题|讨论|会话|对话|分析|研究|总结)$/u.test(title)
    || /(?:相关问题|问题探讨|话题讨论|会话总结|对话记录|综合分析|对比分析|的对话|的讨论|的会话)$/u.test(title)
    || /^(?:用户请求|用户问题|会话标题|新会话|新对话)$/u.test(title);
}

function looksLikeTruncatedTitle(title: string) {
  const compact = title.replace(/\s+/g, '');
  if (compact.length < 3) return false;
  const completeEndings = [
    '分析', '研究', '统计', '评估', '搜索', '介绍', '推荐', '查询', '导出',
    '指导', '推理', '设计', '规划', '优化', '比较', '对比', '修复', '生成',
    '总结', '检索', '说明', '配置', '部署', '实现'
  ];
  if (completeEndings.some((ending) => compact.endsWith(ending))) return false;
  return /[推荐查询介绍析研统评估搜索导]$/u.test(compact);
}

function isUsableConversationTitle(title: string) {
  const normalized = clipTitle(title);
  if (!normalized || isDefaultConversationTitle(normalized)) return false;
  if (
    Array.from(normalized).length < 2
    || looksLikeTemplateTitle(normalized)
    || looksLikeTruncatedTitle(normalized)
  ) return false;
  if (/\n|^(?:标题|title)\s*[:：]/iu.test(normalized)) return false;
  // A title should be scannable in a sidebar, not a generated explanation.
  if (/[。！？!?]$/.test(normalized) || normalized.split(/\s+/u).length > 9) return false;
  return true;
}

export function normalizeConversationTitle(content: string) {
  const title = clipTitle(cleanGeneratedTitle(content));
  return isUsableConversationTitle(title) ? title : '';
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function nameUntitledConversation(
  id: string,
  question: string,
  scope: ConversationTitleScope
) {
  const conversation = await getChatConversationOwnedBy(id, scope);
  if (!conversation || !isDefaultConversationTitle(conversation.title)) {
    return conversation?.title;
  }
  const q = String(question || '').trim();
  if (!q) return conversation.title;
  const title = await generateConversationTitle(q);
  if (!title || isDefaultConversationTitle(title)) return conversation.title;
  const latest = await getChatConversationOwnedBy(id, scope);
  if (!latest || !isDefaultConversationTitle(latest.title)) {
    return latest?.title;
  }
  return updateChatConversationTitleIfDefault(id, title, scope);
}

export function scheduleUntitledConversationTitle(input: {
  conversationId: string;
  question: string;
  currentTitle?: string | null;
  scope: ConversationTitleScope;
  onNamed?: (title: string) => void;
}) {
  if (!isDefaultConversationTitle(input.currentTitle)) return;
  void nameUntitledConversation(input.conversationId, input.question, input.scope)
    .then((nextTitle) => {
      if (nextTitle && !isDefaultConversationTitle(nextTitle)) input.onNamed?.(nextTitle);
    })
    .catch((error) => {
      console.warn('[chat-title] name-on-send failed', error);
    });
}

/** 用户发出首条消息后：生成类似 Codex/Cursor 的短任务标题。 */
export async function generateConversationTitle(question: string, answer = '') {
  const rawContext = String(answer || '').replace(/\r\n?/g, '\n').trim();
  const context = normalizeTitleWhitespace(rawContext).slice(0, 500);
  const explicitContextTitle = rawContext.match(/(?:报告题目|成果题目|文章题目)\s*[:：]\s*([^\n]+)/u)?.[1];
  const fallback = summarizeConversationTitle(explicitContextTitle || question);
  const q = normalizeTitleWhitespace(question);
  if (!q) return fallback;

  const userBlock = [
    `首条请求：${q.slice(0, 700)}`,
    context ? `补充上下文（只用于理解主题）：${context}` : '',
    '',
    '把首条请求压缩成一个短任务名。只输出标题本身，不要解释。'
  ].filter(Boolean).join('\n');

  const { completeChat } = await import('./llm');
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      if (attempt > 1) await wait(500);
      const { content } = await completeChat(
        [
          {
            role: 'system',
            content:
              [
                '你是科研助手的会话标题编辑器，不回答用户问题。',
                '标题风格像 Codex、Cursor：短、具体、克制、方便在侧栏扫描；优先“动作 + 对象”或“主题 + 目标”的任务名。',
                '中文通常 6-18 个汉字；英文通常 2-6 个词；中英混合最多 28 个字符。',
                '保留专有名词、学校/人名、型号、文件名、函数名和技术名；删除礼貌用语、背景铺垫、重复内容。',
                '禁止：完整问句、宣传语、公文套话、“关于……的讨论”、元话术、半截词、引号、编号、句末标点。',
                '可参考：储能调度优化、比较两校电力实力、查找郭苏老师资料、修复登录重定向、Explain inverter stability。',
                '只输出一行纯文本标题。'
              ].join(' ')
          },
          {
            role: 'user',
            content: userBlock
          }
        ],
        {
          max_tokens: 48,
          temperature: 0.2,
          signal: AbortSignal.timeout(15_000)
        }
      );

      const titled = normalizeConversationTitle(content);
      if (titled) return titled;
      lastError = new Error(`invalid title content: ${JSON.stringify(String(content || '').slice(0, 120))}`);
    } catch (error) {
      lastError = error;
    }
  }

  console.warn(
    '[chat-title] generateConversationTitle fallback:',
    lastError instanceof Error ? lastError.message : lastError
  );
  return fallback;
}

export async function listChatConversations(userId?: string, kind: ConversationKind = 'chat') {
  const normalizedKind = normalizeConversationKind(kind);
  const rows = userId
    ? await all<ConversationQueryRow>(
      `SELECT ${CONVERSATION_COLUMNS}
       FROM chat_conversations
       WHERE user_id = ? AND COALESCE(kind, 'chat') = ?
       ORDER BY updated_at DESC, created_at DESC`,
      [userId, normalizedKind]
    )
    : await all<ConversationQueryRow>(
      `SELECT ${CONVERSATION_COLUMNS}
       FROM chat_conversations
       WHERE COALESCE(kind, 'chat') = ?
       ORDER BY updated_at DESC, created_at DESC`,
      [normalizedKind]
    );
  return rows.map(mapConversationRow);
}

export async function getChatConversation(id: string) {
  const row = await get<ConversationQueryRow>(
    `SELECT ${CONVERSATION_COLUMNS}
     FROM chat_conversations WHERE id = ?`,
    [id]
  );
  return row ? mapConversationRow(row) : undefined;
}

export async function getChatConversationOwnedBy(id: string, scope: ConversationTitleScope) {
  const row = await get<ConversationQueryRow>(
    `SELECT ${CONVERSATION_COLUMNS}
     FROM chat_conversations
     WHERE id = ? AND user_id = ? AND COALESCE(kind, 'chat') = ?`,
    [id, scope.userId, normalizeConversationKind(scope.kind)]
  );
  return row ? mapConversationRow(row) : undefined;
}

type ConversationTitleContextRow = ConversationQueryRow & {
  first_user_content: string | null;
  first_assistant_content: string | null;
  first_assistant_report_title: string | null;
};

/** Read all title inputs from one owner-scoped database snapshot. */
export async function getChatConversationTitleContext(
  id: string,
  scope: ConversationTitleScope
) {
  const row = await get<ConversationTitleContextRow>(
    `SELECT ${CONVERSATION_COLUMNS},
            (
              SELECT content
              FROM chat_messages
              WHERE conversation_id = chat_conversations.id AND role = 'user'
              ORDER BY created_at ASC, id ASC
              LIMIT 1
            ) AS first_user_content,
            (
              SELECT content
              FROM chat_messages
              WHERE conversation_id = chat_conversations.id AND role = 'assistant'
              ORDER BY created_at ASC, id ASC
              LIMIT 1
            ) AS first_assistant_content,
            (
              SELECT report_title
              FROM research_review_artifacts
              WHERE conversation_id = chat_conversations.id
                AND message_id = (
                  SELECT id
                  FROM chat_messages
                  WHERE conversation_id = chat_conversations.id AND role = 'assistant'
                  ORDER BY created_at ASC, id ASC
                  LIMIT 1
                )
              ORDER BY created_at DESC, id DESC
              LIMIT 1
            ) AS first_assistant_report_title
     FROM chat_conversations
     WHERE id = ? AND user_id = ? AND COALESCE(kind, 'chat') = ?`,
    [id, scope.userId, normalizeConversationKind(scope.kind)]
  );
  if (!row) return null;
  const {
    first_user_content: firstUserContent,
    first_assistant_content: firstAssistantContent,
    first_assistant_report_title: firstAssistantReportTitle,
    ...conversationRow
  } = row;
  return {
    conversation: mapConversationRow(conversationRow),
    firstUserContent,
    firstAssistantContent,
    firstAssistantReportTitle
  };
}

export async function saveConversationSkillIds(id: string, skillIds: unknown) {
  const ids = normalizeSkillIds(skillIds);
  await run(
    `UPDATE chat_conversations
     SET skill_ids_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [ids.length ? JSON.stringify(ids) : null, id],
    true
  );
  return getChatConversation(id);
}

export async function assertConversationOwner(
  conversationId: string,
  userId: string,
  expectedKind?: ConversationKind
) {
  const conversation = await getChatConversation(conversationId);
  if (!conversation) return { conversation: null, allowed: true as const, exists: false as const };
  if (expectedKind && normalizeConversationKind(conversation.kind) !== expectedKind) {
    return { conversation: null, allowed: false as const, exists: true as const };
  }
  if (conversation.user_id !== userId) {
    return { conversation, allowed: false as const, exists: true as const };
  }
  return { conversation, allowed: true as const, exists: true as const };
}

export async function getChatMessages(conversationId: string) {
  const [rows, attachments, artifactsByMessage] = await Promise.all([
    all<ChatMessageRow>(
      'SELECT id, conversation_id, role, content, sources_json, graph_seed_ids_json, agent_steps_json, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
      [conversationId]
    ),
    listChatAttachmentBindings(conversationId),
    listResearchReviewArtifactsByMessages(conversationId).catch(() => new Map())
  ]);
  const attachmentsByMessage = new Map<string, ChatAttachment[]>();
  for (const attachment of attachments) {
    if (!attachment.messageId) continue;
    const current = attachmentsByMessage.get(attachment.messageId) || [];
    current.push(attachment);
    attachmentsByMessage.set(attachment.messageId, current);
  }
  return rows.map((row) => {
    const parsedSteps = parseAgentSteps(row.agent_steps_json);
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      attachments: attachmentsByMessage.get(row.id),
      artifacts: artifactsByMessage.get(row.id),
      sources: row.sources_json ? JSON.parse(row.sources_json) as ChatSource[] : undefined,
      graphSeedIds: row.graph_seed_ids_json ? JSON.parse(row.graph_seed_ids_json) as string[] : undefined,
      agentSteps: parsedSteps.steps,
      thinkingDurationMs: parsedSteps.thinkingDurationMs,
      contextUsage: parsedSteps.contextUsage,
      inProgress: parsedSteps.inProgress,
      chatModel: parsedSteps.chatModel,
      thinkingId: parsedSteps.thinkingId,
      createdAt: row.created_at
    };
  }) satisfies ChatHistoryMessage[];
}

export async function getChatMessageScope(id: string) {
  return get<Pick<ChatMessageRow, 'conversation_id' | 'role'>>(
    'SELECT conversation_id, role FROM chat_messages WHERE id = ?',
    [id]
  );
}

export async function listChatHistory(userId?: string, kind: ConversationKind = 'chat') {
  const [conversations, stats] = await Promise.all([
    listChatConversations(userId, kind),
    all<{ conversation_id: string; count: number; last_user_at: string | null }>(
      `SELECT conversation_id,
              COUNT(*) AS count,
              MAX(CASE WHEN role = 'user' THEN created_at END) AS last_user_at
       FROM chat_messages
       GROUP BY conversation_id`
    )
  ]);
  const statsById = new Map(stats.map((row) => [row.conversation_id, row]));
  return sortConversationsByLastUser(conversations.map((conversation) => {
    const row = statsById.get(conversation.id);
    return {
      ...conversation,
      messageCount: Number(row?.count || 0),
      last_user_at: row?.last_user_at || conversation.created_at
    };
  }));
}

export async function createChatConversation(
  id: string,
  title: string,
  userId?: string,
  reasoningRatio?: number,
  kind: ConversationKind = 'chat',
  thunder = false,
  chatModel?: ChatModelId
) {
  const ratio =
    reasoningRatio == null ? null : normalizeConversationReasoningRatio(reasoningRatio);
  const model = normalizeChatModelId(chatModel, parseChatThunder(thunder) ? 'thunder' : 'arc');
  const thunderOn = model === 'thunder';
  await run(
    'INSERT INTO chat_conversations (id, title, user_id, reasoning_ratio, thunder, chat_model, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    [id, title, userId || null, ratio, thunderOn ? 1 : 0, model, normalizeConversationKind(kind)],
    true
  );
  return getChatConversation(id);
}

export async function updateChatConversationTitle(
  id: string,
  title: string,
  scope: ConversationTitleScope
) {
  const result = await run(
    `UPDATE chat_conversations
     SET title = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND COALESCE(kind, 'chat') = ?`,
    [title, id, scope.userId, normalizeConversationKind(scope.kind)],
    true
  );
  return result.changes > 0 ? title : undefined;
}

/** Update only an untouched placeholder, so concurrent title requests are harmless. */
export async function updateChatConversationTitleIfDefault(
  id: string,
  title: string,
  scope: ConversationTitleScope
) {
  const result = await run(
    `UPDATE chat_conversations
     SET title = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND user_id = ?
       AND COALESCE(kind, 'chat') = ?
       AND (title IS NULL OR TRIM(title) IN (?, ?))`,
    [
      title,
      id,
      scope.userId,
      normalizeConversationKind(scope.kind),
      DEFAULT_CONVERSATION_TITLE,
      '新对话'
    ],
    true
  );
  if (result.changes > 0) return title;
  return (await getChatConversationOwnedBy(id, scope))?.title;
}

export async function touchChatConversation(id: string) {
  await run('UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id], true);
}

/** Persist reasoning ratio once (first message); later turns keep the locked value. */
export async function lockConversationReasoningRatio(id: string, reasoningRatio: number) {
  const ratio = normalizeConversationReasoningRatio(reasoningRatio);
  await run(
    `UPDATE chat_conversations
     SET reasoning_ratio = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND reasoning_ratio IS NULL`,
    [ratio, id],
    true
  );
  return getChatConversation(id);
}

export async function conversationHasMessages(id: string) {
  const row = await get<{ n?: number | string | bigint }>(
    'SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?',
    [id]
  );
  return Number(row?.n || 0) > 0;
}

/**
 * 记录本会话所用模型（thunder 列保留作旧数据兼容）。对话开始后不可改。
 * 【按线上版本还原】旧版「Thunder 开 = 锁最高思考档」的逻辑已由思考档选择取代。
 */
export async function saveConversationChatModel(
  id: string,
  chatModel: unknown,
  reasoningRatio?: number
) {
  if (await conversationHasMessages(id)) {
    return getChatConversation(id);
  }
  const model = normalizeChatModelId(chatModel);
  const thunderOn = model === 'thunder' ? 1 : 0;
  if (reasoningRatio == null) {
    await run(
      `UPDATE chat_conversations
       SET chat_model = ?, thunder = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [model, thunderOn, id],
      true
    );
  } else {
    await run(
      `UPDATE chat_conversations
       SET chat_model = ?, thunder = ?, reasoning_ratio = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [model, thunderOn, normalizeConversationReasoningRatio(reasoningRatio), id],
      true
    );
  }
  return getChatConversation(id);
}

/** 旧接口：Thunder 开关等价于选择 thunder / arc 模型。 */
export async function saveConversationThunder(id: string, thunder: boolean) {
  return saveConversationChatModel(id, parseChatThunder(thunder) ? 'thunder' : 'arc');
}

export async function patchChatConversation(
  id: string,
  input: { thunder?: unknown; chatModel?: unknown; chat_model?: unknown }
) {
  if ('chatModel' in input || 'chat_model' in input) {
    await saveConversationChatModel(id, normalizeChatModelId(input.chatModel));
  } else if ('thunder' in input) {
    await saveConversationThunder(id, parseChatThunder(input.thunder));
  }
  return getChatConversation(id);
}

export async function ensureChatConversation(
  id: string,
  title: string,
  userId: string,
  reasoningRatio?: number,
  kind: ConversationKind = 'chat',
  thunder?: boolean,
  chatModel?: ChatModelId
) {
  const existing = await getChatConversation(id);
  if (existing) {
    if (
      existing.user_id !== userId
      || normalizeConversationKind(existing.kind) !== normalizeConversationKind(kind)
    ) {
      throw new Error('Conversation ID is already bound to a different owner or kind.');
    }
    if (existing.reasoning_ratio == null && reasoningRatio != null) {
      await lockConversationReasoningRatio(id, reasoningRatio);
    }
    if (!(await conversationHasMessages(id))) {
      if (chatModel) {
        return (await saveConversationChatModel(id, chatModel, reasoningRatio)) || existing;
      }
      if (thunder != null) {
        return (await saveConversationThunder(id, thunder)) || existing;
      }
    }
    return (await getChatConversation(id)) || existing;
  }
  return createChatConversation(id, title, userId, reasoningRatio, kind, thunder === true, chatModel);
}

export async function appendChatMessage(input: {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
  graphSeedIds?: string[];
  agentSteps?: RuntimeAgentStep[];
  thinkingDurationMs?: number;
  contextUsage?: ModelContextUsage;
  inProgress?: boolean;
  chatModel?: ChatModelId;
  thinkingId?: string;
}) {
  await run(
    'INSERT INTO chat_messages (id, conversation_id, role, content, sources_json, graph_seed_ids_json, agent_steps_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
    [
      input.id,
      input.conversationId,
      input.role,
      input.content,
      input.sources ? JSON.stringify(input.sources) : null,
      input.graphSeedIds ? JSON.stringify(input.graphSeedIds) : null,
      serializeAgentSteps(input)
    ],
    true
  );
  if (input.role === 'user') {
    await touchChatConversation(input.conversationId);
  }
}

export async function deleteChatConversation(id: string) {
  await withTransaction(async (database) => {
    await lockConversationQueueMutation(database, id);
    await database.prepare('DELETE FROM chat_message_attachments WHERE conversation_id = ?').run(id);
    await database.prepare('DELETE FROM chat_attachment_chunks WHERE conversation_id = ?').run(id);
    await database.prepare('DELETE FROM chat_attachments WHERE conversation_id = ?').run(id);
    await database.prepare('DELETE FROM chat_send_queue WHERE conversation_id = ?').run(id);
    await database.prepare('DELETE FROM research_review_artifacts WHERE conversation_id = ?').run(id);
    await database.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id);
    await database.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id);
  }, true);
  // Database rows are already gone; these helpers perform best-effort filesystem cleanup.
  await deleteConversationAttachments(id);
  await deleteResearchReviewArtifacts(id).catch(() => 0);
  resetOpenCodeSessionForConversation(id);
  removeChatWorkspace(id);
}

/**
 * Reclaim a placeholder conversation only while it is still completely unused.
 * Callers must hold the conversation mutation lease so a generation or another
 * attachment mutation cannot start between its final write and this delete.
 */
export async function deleteEmptyChatConversationOwnedBy(
  id: string,
  userId: string,
  kind: ConversationKind = 'chat'
) {
  const result = await run(
    `DELETE FROM chat_conversations
     WHERE id = ?
       AND user_id = ?
       AND COALESCE(kind, 'chat') = ?
       AND NOT EXISTS (
         SELECT 1 FROM chat_messages WHERE conversation_id = chat_conversations.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM chat_attachments WHERE conversation_id = chat_conversations.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM chat_send_queue WHERE conversation_id = chat_conversations.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM research_review_artifacts WHERE conversation_id = chat_conversations.id
       )`,
    [id, userId, normalizeConversationKind(kind)],
    true
  );
  if (result.changes === 0) return false;
  resetOpenCodeSessionForConversation(id);
  removeChatWorkspace(id);
  return true;
}

function resetOpenCodeSessionForConversation(conversationId: string) {
  deleteOpenCodeSessionMapping(conversationId);
  deleteOpenCodeSessionMapping(conversationId, RESEARCH_REVIEW_SESSION_MAP);
}

async function deleteMessageRows(conversationId: string, messageIds: string[]) {
  if (!messageIds.length) return false;
  await withTransaction(async (database) => {
    const deleteBindings = database.prepare(
      'DELETE FROM chat_message_attachments WHERE conversation_id = ? AND message_id = ?'
    );
    const deleteArtifacts = database.prepare(
      'DELETE FROM research_review_artifacts WHERE conversation_id = ? AND message_id = ?'
    );
    const deleteMessage = database.prepare('DELETE FROM chat_messages WHERE id = ?');
    for (const messageId of messageIds) {
      await deleteBindings.run(conversationId, messageId);
      await deleteArtifacts.run(conversationId, messageId);
      await deleteMessage.run(messageId);
    }
  }, true);
  resetOpenCodeSessionForConversation(conversationId);
  await touchChatConversation(conversationId);
  return true;
}

async function deleteMessagesFromIndex(conversationId: string, messages: ChatHistoryMessage[], index: number) {
  if (index < 0 || index >= messages.length) return false;
  return deleteMessageRows(conversationId, messages.slice(index).map((message) => message.id));
}

/** 删除指定消息及其之后的全部消息，并重置 OpenCode 会话映射，供「重新发送」截断历史。 */
export async function truncateChatMessagesFrom(conversationId: string, fromMessageId: string) {
  const messages = await getChatMessages(conversationId);
  const index = messages.findIndex((message) => message.id === fromMessageId);
  return deleteMessagesFromIndex(conversationId, messages, index);
}

/** OpenCode 式回撤：撤销本条及之后的对话，不自动重发。 */
export async function revertChatMessagesFrom(conversationId: string, fromMessageId: string) {
  return truncateChatMessagesFrom(conversationId, fromMessageId);
}

/** 只删除这一条消息，后面的对话保留；历史已变，仍重置 OpenCode 会话映射。 */
export async function deleteChatMessage(conversationId: string, messageId: string) {
  const messages = await getChatMessages(conversationId);
  const target = messages.find((message) => message.id === messageId);
  if (!target) return false;
  return deleteMessageRows(conversationId, [target.id]);
}

/**
 * 按「保留前 N 条」截断（用于前端临时 ID 与库内 ID 不一致时的重新发送兜底）。
 * keepCount = 重新发送目标之前仍保留的消息条数。
 */
export async function truncateChatMessagesKeepFirst(conversationId: string, keepCount: number) {
  if (!Number.isFinite(keepCount) || keepCount < 0) return false;
  const messages = await getChatMessages(conversationId);
  const index = Math.min(Math.floor(keepCount), messages.length);
  if (index >= messages.length) return true;
  return deleteMessagesFromIndex(conversationId, messages, index);
}

export async function getChatConversationWithMessages(id: string) {
  const conversation = await getChatConversation(id);
  if (!conversation) return null;
  const messages = await getChatMessages(id);
  return { conversation, messages };
}

export async function upsertChatMessage(input: {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
  graphSeedIds?: string[];
  agentSteps?: RuntimeAgentStep[];
  thinkingDurationMs?: number;
  contextUsage?: ModelContextUsage;
  inProgress?: boolean;
  chatModel?: ChatModelId;
  thinkingId?: string;
}) {
  const existing = await getChatMessageScope(input.id);
  if (
    existing
    && (existing.conversation_id !== input.conversationId || existing.role !== input.role)
  ) {
    throw new Error('Chat message ID is already bound to a different conversation or role.');
  }
  if (existing) {
    await run(
      `UPDATE chat_messages
       SET content = ?, sources_json = ?, graph_seed_ids_json = ?, agent_steps_json = ?
       WHERE id = ? AND conversation_id = ? AND role = ?`,
      [
        input.content,
        input.sources ? JSON.stringify(input.sources) : null,
        input.graphSeedIds ? JSON.stringify(input.graphSeedIds) : null,
        serializeAgentSteps(input),
        input.id,
        input.conversationId,
        input.role
      ],
      true
    );
    if (input.role === 'user') {
      await touchChatConversation(input.conversationId);
    }
    return;
  }
  await appendChatMessage(input);
}
