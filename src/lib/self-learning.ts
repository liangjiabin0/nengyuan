import { createHash } from 'node:crypto';
import path from 'node:path';
import { all, get, run } from './db';
import type { RuntimeAgentStep } from './opencode/types';
import { learningSearchDocument, learningTsQuery } from './self-learning-search';

const MAX_ACTIVE_MEMORIES_PER_DOMAIN = 30;
const MAX_PINNED_MEMORIES = 5;
const MAX_PINNED_PROMPT_CHARS = 800;
const MAX_SEARCH_RESULTS = 5;

const MEMORY_COLUMNS = `id, user_id, domain_key, domain_label, memory_kind, instruction, operation,
            applicability, keywords_json, fingerprint, confidence, active, pinned,
            source_conversation_id, created_at, updated_at`;

export type LearningHistoryMessage = {
  role?: string;
  content?: string;
  agentSteps?: RuntimeAgentStep[];
};

export type SelfLearningMemory = {
  id: string;
  userId: string;
  domainKey: string;
  domainLabel: string;
  kind: string;
  instruction: string;
  operation: string;
  applicability: string;
  keywords: string[];
  confidence: number;
  active: boolean;
  pinned: boolean;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
};

type SelfLearningMemoryRow = {
  id: string;
  user_id: string;
  domain_key: string;
  domain_label: string;
  memory_kind: string;
  instruction: string;
  operation: string;
  applicability: string;
  keywords_json: string;
  fingerprint: string;
  confidence: number;
  active: number;
  pinned: number;
  source_conversation_id: string | null;
  created_at: string;
  updated_at: string;
};

export type LearningDomain = {
  key: string;
  label: string;
  keywords: string[];
  updatedAt?: string;
};

export const GENERAL_LEARNING_DOMAIN: LearningDomain = {
  key: 'general/conversation',
  label: '通用对话',
  keywords: ['通用对话']
};

type ExtractedLearning = {
  domainKey: string;
  domainLabel: string;
  memories: Array<{
    kind: 'instruction' | 'preference' | 'workflow' | 'correction';
    instruction: string;
    operation: string;
    applicability: string;
    keywords: string[];
    confidence: number;
  }>;
};

const LEARN_ACTION_RE = /(?:学习|记住|记下|记下来|记一下|沉淀|保存(?:下来|为经验)?|加入(?:你的|我的|长期)?记忆|写进(?:你的|我的|长期)?记忆|写入(?:你的|我的|长期)?记忆|记到(?:你的|我的|长期)?记忆|存进(?:你的|我的|长期)?记忆|保存到(?:你的|我的|长期)?记忆|总结成经验)/i;
const LEARN_CONTEXT_RE = /(?:用户指令|用户要求|修改反馈|纠错反馈|偏好|习惯|风格|规则|这次|本次|本轮|刚才|之前|此前|上面|前面|这段对话|长期记忆|经验)/i;
const MEMORY_WRITE_RE = /(?:写进|写入|记到|存进|保存到|加入)(?:你的|我的|长期)?记忆/;
const REMEMBER_COMMAND_RE = /(?:^|[，。；;！!？?\n]\s*)(?:请|麻烦|帮我|让(?:AI|ai|你|助手)|希望(?:你|AI|ai|助手)|可以请你)?(?:记住|记下|记下来|记一下)/;
const DIRECT_LEARN_RE = /(?:^|[，。；;！!？?]\s*)(?:请|麻烦)?(?:学习|记住|记下|记下来|沉淀|保存|总结成经验)|(?:请|麻烦|帮我|让(?:AI|ai|你|助手)|希望(?:你|AI|ai|助手)|可以请你).{0,16}(?:学习|记住|记下|沉淀|保存|加入记忆|写进记忆|写入记忆|总结成经验)/i;
const NEGATED_LEARN_RE = /(?:不要|别|不用|无需|不需要|不必)(?:把.{0,8})?(?:这次|本次|本轮|这个)?(?:再)?(?:学习|记住|记下|记下来|沉淀|保存(?:下来|为经验)?|加入(?:你的|我的|长期)?记忆|写进(?:你的|我的|长期)?记忆|写入(?:你的|我的|长期)?记忆)/i;
const ENGLISH_LEARN_RE = /(?:\b(?:please|can you|could you)\b.{0,24})?\b(?:remember|save|retain)\b.{0,80}\b(?:instruction|feedback|correction|preference|workflow|experience|conversation)\b|\b(?:learn)\b.{0,50}\b(?:from this|from the previous|our previous|this conversation)\b/i;
const ENGLISH_NEGATED_RE = /\b(?:do not|don't|never)\b.{0,20}\b(?:learn|remember|save|retain)\b/i;

function normalizedLearningText(text: string) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function detectsNegatedLearningRequest(text: string) {
  const normalized = normalizedLearningText(text);
  if (!normalized) return false;
  return NEGATED_LEARN_RE.test(normalized) || ENGLISH_NEGATED_RE.test(normalized);
}

export function detectsExplicitLearningRequest(text: string) {
  const normalized = normalizedLearningText(text);
  if (!normalized) return false;
  if (detectsNegatedLearningRequest(normalized)) return false;
  if (ENGLISH_LEARN_RE.test(normalized)) return true;
  if (MEMORY_WRITE_RE.test(normalized) || REMEMBER_COMMAND_RE.test(normalized)) return true;
  return DIRECT_LEARN_RE.test(normalized) && LEARN_ACTION_RE.test(normalized) && LEARN_CONTEXT_RE.test(normalized);
}

function clip(value: unknown, max: number) {
  const text = String(value || '').replace(/\u0000/g, '').trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function redactSensitiveValues(value: unknown, max: number) {
  return clip(value, max)
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi, '[已移除私钥]')
    .replace(/\b(?:sk|pk)-[a-z0-9_-]{16,}\b/gi, '[已移除密钥]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd)\b(\s*[:=：]\s*)[^\s，。；;]{4,}/gi, '$1$2[已移除敏感值]')
    .replace(/(密码|口令|令牌|密钥)(\s*[:=：]\s*)[^\s，。；;]{4,}/g, '$1$2[已移除敏感值]');
}

function parseKeywords(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、;；\n]/)
      : [];
  return [...new Set(raw
    .map((item) => clip(item, 40))
    .filter((item) => item.length >= 2))]
    .slice(0, 10);
}

function isUnderDirectory(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function conversationIdFromWorkspace(workspace: string) {
  const root = path.resolve(process.cwd(), 'storage', 'chat-workspaces');
  const resolved = path.resolve(String(workspace || '').trim() || '.');
  if (!isUnderDirectory(root, resolved)) return null;
  const relative = path.relative(root, resolved).replace(/\\/g, '/');
  const id = relative.split('/')[0] || '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

function resolveSavedDomain(domainKey?: unknown, domainLabel?: unknown) {
  const label = clip(domainLabel, 80);
  const key = clip(domainKey, 80);
  if (!key && !label) return GENERAL_LEARNING_DOMAIN;
  if (key === GENERAL_LEARNING_DOMAIN.key || label === GENERAL_LEARNING_DOMAIN.label) {
    return GENERAL_LEARNING_DOMAIN;
  }
  const resolvedKey = normalizeLearningDomainKey(key, label || GENERAL_LEARNING_DOMAIN.label);
  return {
    key: resolvedKey,
    label: label || GENERAL_LEARNING_DOMAIN.label,
    keywords: [] as string[]
  };
}

export function normalizeAgentLearningMemory(input: {
  instruction?: unknown;
  kind?: unknown;
  operation?: unknown;
  applicability?: unknown;
  keywords?: unknown;
  domainKey?: unknown;
  domainLabel?: unknown;
}): ExtractedLearning {
  const instruction = redactSensitiveValues(input.instruction, 900);
  if (instruction.length < 4) throw new Error('缺少可复用经验正文。');
  const domain = resolveSavedDomain(input.domainKey, input.domainLabel);
  const rawKind = String(input.kind || 'preference');
  const kind = ['instruction', 'preference', 'workflow', 'correction'].includes(rawKind)
    ? rawKind as ExtractedLearning['memories'][number]['kind']
    : 'preference';
  return {
    domainKey: domain.key,
    domainLabel: domain.label,
    memories: [{
      kind,
      instruction,
      operation: redactSensitiveValues(input.operation, 1_200),
      applicability: redactSensitiveValues(input.applicability, 600),
      keywords: parseKeywords(input.keywords),
      confidence: 0.9
    }]
  };
}

export async function latestUserMessageForLearning(conversationId: string) {
  return get<{ id: string; content: string }>(
    `SELECT id, content FROM chat_messages
     WHERE conversation_id = ? AND role = 'user'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [conversationId]
  );
}

function rowToMemory(row: SelfLearningMemoryRow): SelfLearningMemory {
  let keywords: unknown = [];
  try {
    keywords = JSON.parse(row.keywords_json || '[]');
  } catch {
    keywords = [];
  }
  return {
    id: row.id,
    userId: row.user_id,
    domainKey: row.domain_key,
    domainLabel: row.domain_label,
    kind: row.memory_kind,
    instruction: row.instruction,
    operation: row.operation,
    applicability: row.applicability,
    keywords: parseKeywords(keywords),
    confidence: Number(row.confidence || 0),
    active: Number(row.active) === 1,
    pinned: Number(row.pinned) === 1,
    sourceConversationId: row.source_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizedFingerprintText(value: string) {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function learningMemoryFingerprint(instruction: string, applicability: string) {
  return createHash('sha256')
    .update(`${normalizedFingerprintText(instruction)}\n${normalizedFingerprintText(applicability)}`)
    .digest('hex');
}

export function normalizeLearningDomainKey(value: string, label: string) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (cleaned && /[a-z0-9]/.test(cleaned)) return cleaned;
  const digest = createHash('sha256').update(String(label || 'general')).digest('hex').slice(0, 12);
  return `topic/${digest}`;
}

function explicitDomain(text: string): LearningDomain | null {
  const match = String(text || '').match(/(?:学习领域|记忆领域|领域)\s*[:：]\s*([^，。；;\n]{2,40})/u);
  if (!match?.[1]) return null;
  const label = clip(match[1], 40);
  return { key: normalizeLearningDomainKey('', label), label, keywords: [label] };
}

function scoreDomain(text: string, domain: LearningDomain) {
  const haystack = text.toLowerCase();
  let score = 0;
  if (domain.label.length >= 2 && haystack.includes(domain.label.toLowerCase())) score += 8;
  for (const keyword of domain.keywords) {
    const needle = keyword.toLowerCase().trim();
    if (needle.length >= 2 && haystack.includes(needle)) score += Math.min(6, 2 + needle.length / 4);
  }
  return score;
}

/** Returns one unambiguous domain only. A tie deliberately disables recall. */
export function chooseLearningDomain(text: string, domains: LearningDomain[]) {
  const explicit = explicitDomain(text);
  if (explicit) {
    return domains.find((domain) => domain.label === explicit.label) || explicit;
  }
  const ranked = domains
    .map((domain) => ({ domain, score: scoreDomain(text, domain) }))
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  if (ranked[1] && Math.abs(ranked[0]!.score - ranked[1]!.score) < 0.5) return null;
  return ranked[0]!.domain;
}

export async function listUserLearningDomains(userId: string): Promise<LearningDomain[]> {
  const rows = await all<SelfLearningMemoryRow>(
    `SELECT ${MEMORY_COLUMNS}
     FROM self_learning_memories
     WHERE user_id = ? AND active = 1
     ORDER BY updated_at DESC`,
    [userId]
  );
  const byKey = new Map<string, LearningDomain>();
  for (const row of rows) {
    const memory = rowToMemory(row);
    const current = byKey.get(memory.domainKey);
    if (!current) {
      byKey.set(memory.domainKey, {
        key: memory.domainKey,
        label: memory.domainLabel,
        keywords: [...memory.keywords],
        updatedAt: memory.updatedAt
      });
      continue;
    }
    current.keywords = [...new Set([...current.keywords, ...memory.keywords])].slice(0, 24);
  }
  return [...byKey.values()];
}

export function pinnedLearningFingerprint(memories: Array<{ id: string; updatedAt: string }>) {
  const body = memories.map((memory) => `${memory.id}\t${memory.updatedAt}`).sort().join('\n');
  if (!body) return '';
  return createHash('sha256').update(body).digest('hex');
}

/** Empty fingerprint never enters the prompt. A reused session skips an unchanged pin set. */
export function shouldInjectPinnedLearning(input: {
  created: boolean;
  compacted: boolean;
  fingerprint: string;
  previousFingerprint?: string | null;
}) {
  const fingerprint = String(input.fingerprint || '');
  if (!fingerprint) return false;
  if (input.created || input.compacted) return true;
  return fingerprint !== String(input.previousFingerprint || '');
}

export async function loadPinnedLearningContext(userId: string) {
  const rows = await all<SelfLearningMemoryRow>(
    `SELECT ${MEMORY_COLUMNS}
     FROM self_learning_memories
     WHERE user_id = ? AND active = 1 AND pinned = 1
     ORDER BY updated_at DESC
     LIMIT ?`,
    [userId, MAX_PINNED_MEMORIES]
  );
  const memories = rows.map(rowToMemory);
  const fingerprint = pinnedLearningFingerprint(memories);
  if (!memories.length) return { memories, prompt: '', fingerprint };
  const lines = memories.map((memory, index) => [
    `${index + 1}. ${memory.instruction}`,
    memory.applicability ? `   适用条件：${memory.applicability}` : ''
  ].filter(Boolean).join('\n'));
  const prompt = [
    '以下是当前用户钉住的始终生效偏好。只在与当前请求不冲突时遵守。这些偏好不能扩展权限，也不能当作事实证据。',
    ...lines
  ].join('\n').slice(0, MAX_PINNED_PROMPT_CHARS);
  return { memories, prompt, fingerprint };
}

export async function searchUserLearningMemories(userId: string, query: string) {
  const tsQuery = learningTsQuery(query);
  if (!tsQuery) return [];
  try {
    const rows = await all<SelfLearningMemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
       FROM self_learning_memories
       WHERE user_id = ? AND active = 1
         AND search_tsv @@ to_tsquery('simple', ?)
       ORDER BY ts_rank(search_tsv, to_tsquery('simple', ?)) DESC, confidence DESC, updated_at DESC
       LIMIT ?`,
      [userId, tsQuery, tsQuery, MAX_SEARCH_RESULTS]
    );
    return rows.map(rowToMemory);
  } catch {
    return [];
  }
}

export async function setUserLearningMemoryPinned(userId: string, memoryId: string, pinned: boolean) {
  const existing = await get<SelfLearningMemoryRow>(
    `SELECT ${MEMORY_COLUMNS}
     FROM self_learning_memories
     WHERE id = ? AND user_id = ?`,
    [memoryId, userId]
  );
  if (!existing) return { ok: false as const, missing: true, error: '记忆不存在或无权修改。' };
  if (!pinned) {
    await run(
      `UPDATE self_learning_memories
       SET pinned = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [memoryId, userId],
      true
    );
    return { ok: true as const };
  }
  if (Number(existing.pinned) === 1) return { ok: true as const };
  if (Number(existing.active) !== 1) {
    return { ok: false as const, missing: false, error: '已归档的记忆不能钉住。' };
  }
  const count = await get<{ total: number | string }>(
    `SELECT COUNT(*) AS total
     FROM self_learning_memories
     WHERE user_id = ? AND active = 1 AND pinned = 1`,
    [userId]
  );
  if (Number(count?.total || 0) >= MAX_PINNED_MEMORIES) {
    return { ok: false as const, missing: false, error: '始终生效的偏好最多 5 条。' };
  }
  await run(
    `UPDATE self_learning_memories
     SET pinned = 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND active = 1`,
    [memoryId, userId],
    true
  );
  return { ok: true as const };
}

function summarizeAgentSteps(steps: RuntimeAgentStep[] | undefined) {
  return (steps || [])
    .filter((step) => step.type === 'tool_call' || step.type === 'observation')
    .slice(-16)
    .map((step) => `${step.type === 'tool_call' ? '操作' : '结果'}${step.tool ? `(${step.tool})` : ''}：${clip(step.content, 260)}`)
    .join('\n');
}

export function buildLearningTranscript(input: {
  history?: LearningHistoryMessage[];
  currentQuestion: string;
  currentAnswer: string;
  currentAgentSteps?: RuntimeAgentStep[];
}) {
  const history = (input.history || []).slice(-10).map((message) => {
    const role = message.role === 'assistant' ? '助手' : '用户';
    const operations = message.role === 'assistant' ? summarizeAgentSteps(message.agentSteps) : '';
    return [`${role}：${clip(message.content, 2_000)}`, operations].filter(Boolean).join('\n');
  });
  return [
    ...history,
    `当前用户：${clip(input.currentQuestion, 2_000)}`,
    `当前助手：${clip(input.currentAnswer, 2_500)}`,
    summarizeAgentSteps(input.currentAgentSteps)
  ].filter(Boolean).join('\n\n').slice(-18_000);
}

function extractJsonObject(raw: string) {
  const cleaned = String(raw || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('学习提炼结果不是有效 JSON。');
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

export function parseExtractedLearning(raw: string, forcedDomain?: LearningDomain | null): ExtractedLearning {
  const parsed = extractJsonObject(raw);
  const domainObject = parsed.domain && typeof parsed.domain === 'object'
    ? parsed.domain as Record<string, unknown>
    : {};
  const domainLabel = forcedDomain?.label || clip(domainObject.label, 80) || '通用任务';
  const domainKey = forcedDomain?.key
    || normalizeLearningDomainKey(clip(domainObject.key, 80), domainLabel);
  const rawMemories = Array.isArray(parsed.memories) ? parsed.memories : [];
  const memories = rawMemories.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const instruction = redactSensitiveValues(item.instruction, 900);
    if (instruction.length < 4) return [];
    const rawKind = String(item.kind || 'workflow');
    const kind = ['instruction', 'preference', 'workflow', 'correction'].includes(rawKind)
      ? rawKind as ExtractedLearning['memories'][number]['kind']
      : 'workflow';
    return [{
      kind,
      instruction,
      operation: redactSensitiveValues(item.operation, 1_200),
      applicability: redactSensitiveValues(item.applicability, 600),
      keywords: parseKeywords(item.keywords),
      confidence: Math.max(0.5, Math.min(1, Number(item.confidence) || 0.8))
    }];
  }).slice(0, 4);
  if (!memories.length) throw new Error('没有提炼出可复用经验。');
  return { domainKey, domainLabel, memories };
}

async function upsertExtractedMemory(input: {
  userId: string;
  conversationId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  learning: ExtractedLearning;
}) {
  const saved: SelfLearningMemory[] = [];
  for (const memory of input.learning.memories) {
    const fingerprint = learningMemoryFingerprint(memory.instruction, memory.applicability);
    const searchText = learningSearchDocument({
      instruction: memory.instruction,
      applicability: memory.applicability,
      domainLabel: input.learning.domainLabel,
      keywords: memory.keywords
    });
    const id = crypto.randomUUID();
    await run(
      `INSERT INTO self_learning_memories (
         id, user_id, domain_key, domain_label, memory_kind, instruction, operation,
         applicability, keywords_json, fingerprint, confidence, active, search_text,
         source_conversation_id, source_user_message_id, source_assistant_message_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, domain_key, fingerprint) DO UPDATE SET
         domain_label = EXCLUDED.domain_label,
         memory_kind = EXCLUDED.memory_kind,
         operation = EXCLUDED.operation,
         applicability = EXCLUDED.applicability,
         keywords_json = EXCLUDED.keywords_json,
         search_text = EXCLUDED.search_text,
         confidence = GREATEST(self_learning_memories.confidence, EXCLUDED.confidence),
         active = 1,
         source_conversation_id = EXCLUDED.source_conversation_id,
         source_user_message_id = EXCLUDED.source_user_message_id,
         source_assistant_message_id = EXCLUDED.source_assistant_message_id,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id,
        input.userId,
        input.learning.domainKey,
        input.learning.domainLabel,
        memory.kind,
        memory.instruction,
        memory.operation,
        memory.applicability,
        JSON.stringify(memory.keywords),
        fingerprint,
        memory.confidence,
        searchText,
        input.conversationId,
        input.userMessageId || null,
        input.assistantMessageId || null
      ],
      true
    );
    const row = await get<SelfLearningMemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
       FROM self_learning_memories
       WHERE user_id = ? AND domain_key = ? AND fingerprint = ?`,
      [input.userId, input.learning.domainKey, fingerprint]
    );
    if (row) saved.push(rowToMemory(row));
  }
  await run(
    `UPDATE self_learning_memories SET active = 0, pinned = 0, updated_at = CURRENT_TIMESTAMP
     WHERE id IN (
       SELECT id FROM self_learning_memories
       WHERE user_id = ? AND domain_key = ? AND active = 1
       ORDER BY confidence DESC, updated_at DESC
       OFFSET ?
     )`,
    [input.userId, input.learning.domainKey, MAX_ACTIVE_MEMORIES_PER_DOMAIN],
    true
  );
  return saved;
}

export async function saveUserLearningMemories(input: {
  userId: string;
  conversationId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  learning: ExtractedLearning;
}) {
  return upsertExtractedMemory(input);
}

export async function listUserLearningMemories(userId: string, domainKey?: string) {
  const params: unknown[] = [userId];
  const domainFilter = domainKey ? ' AND domain_key = ?' : '';
  if (domainKey) params.push(domainKey);
  const rows = await all<SelfLearningMemoryRow>(
    `SELECT ${MEMORY_COLUMNS}
     FROM self_learning_memories
     WHERE user_id = ?${domainFilter}
     ORDER BY active DESC, domain_label ASC, updated_at DESC`,
    params
  );
  return rows.map(rowToMemory);
}

export async function deleteUserLearningMemory(userId: string, memoryId: string) {
  const result = await run(
    'DELETE FROM self_learning_memories WHERE id = ? AND user_id = ?',
    [memoryId, userId],
    true
  );
  return Number(result.changes || 0) > 0;
}
