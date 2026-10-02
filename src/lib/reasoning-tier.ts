import {
  type ChatModelId,
  normalizeChatModelId,
  parseChatModelId
} from './model-ids';
import {
  defaultThinkingRatio,
  fallbackThinkingLevels,
  resolveThinkingLevel,
  snapThinkingIdToLevels,
  snapThinkingRatio,
  stepThinkingRatio,
  thinkingStops,
  type ThinkingLevel
} from './thinking-levels-core';

export type ModelRole = 'small' | 'large' | 'storm';
export type ReasoningEffortLevel = 'default' | 'high';
export type SmallThinkingMode = 'off' | 'xhigh';
export type ChatSmallThinkingMode = 'off' | 'medium' | 'xhigh';
export type ChatThinkingId = string;

export type ReasoningTier = {
  ratio: number;
  percent: number;
  modelRole: ModelRole;
  reasoningEffort: ReasoningEffortLevel;
  /** 仅小模型档生效：0–25 关思考，25–50 xhigh */
  smallThinking: SmallThinkingMode;
};

export type ChatReasoningTier = {
  ratio: number;
  percent: number;
  modelRole: 'small';
  smallThinking: ChatSmallThinkingMode;
  thinkingId: ChatThinkingId;
};

/** 科研传承等旧四档滑块：默认最左侧（0–25 关思考） */
export const DEFAULT_REASONING_RATIO = 0;

export const CHAT_REASONING_TIER_META: Record<
  ChatSmallThinkingMode,
  { label: string; description: string }
> = {
  off: { label: '关', description: '关闭思考，偏速度和成本' },
  medium: { label: '中', description: '准度和速度折中' },
  xhigh: { label: '超高', description: '最深，适合复杂分析、长链路 Agent' }
};

export const CHAT_REASONING_STOPS: Record<ChatSmallThinkingMode, number> = {
  off: 0,
  medium: 0.5,
  xhigh: 1
};

/** 智能对话：默认中档 */
export const DEFAULT_CHAT_REASONING_RATIO = CHAT_REASONING_STOPS.medium;

/** 科研传承助手默认：落在最左侧（0–25 档） */
export const RESEARCH_REVIEW_DEFAULT_REASONING_RATIO = 0;

const CHAT_REASONING_MODES: ChatSmallThinkingMode[] = ['off', 'medium', 'xhigh'];

function arcLevels(): ThinkingLevel[] {
  return fallbackThinkingLevels('arc');
}

/** 智能对话滑块只停在 关 / 中 / 超高 */
export function snapChatReasoningRatio(ratio: number, levels?: ThinkingLevel[]): number {
  if (levels?.length) return snapThinkingRatio(ratio, levels);
  return CHAT_REASONING_STOPS[resolveChatReasoningTier(ratio).smallThinking];
}

export function stepChatReasoningRatio(ratio: number, direction: -1 | 1, levels?: ThinkingLevel[]): number {
  if (levels?.length) return stepThinkingRatio(ratio, levels, direction);
  const current = resolveChatReasoningTier(ratio).smallThinking;
  const index = Math.min(
    CHAT_REASONING_MODES.length - 1,
    Math.max(0, CHAT_REASONING_MODES.indexOf(current) + direction)
  );
  return CHAT_REASONING_STOPS[CHAT_REASONING_MODES[index]];
}

/**
 * 推理强度四档（0–100），仅内部路由用，UI 不展示档位名称：
 * 0–25  本地小模型，关闭思考（enable_thinking=false）
 * 25–50 本地小模型，reasoning_effort=xhigh
 * 50–75 远程大模型
 * 75–100 大模型 + 高能量提示词
 */
export function resolveReasoningTier(ratio: number): ReasoningTier {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  const percent = Math.round(clamped * 100);
  if (clamped < 0.25) {
    return { ratio: clamped, percent, modelRole: 'small', reasoningEffort: 'default', smallThinking: 'off' };
  }
  if (clamped < 0.5) {
    return { ratio: clamped, percent, modelRole: 'small', reasoningEffort: 'high', smallThinking: 'xhigh' };
  }
  if (clamped < 0.75) {
    return { ratio: clamped, percent, modelRole: 'large', reasoningEffort: 'default', smallThinking: 'off' };
  }
  return { ratio: clamped, percent, modelRole: 'large', reasoningEffort: 'high', smallThinking: 'off' };
}

/**
 * 智能对话思考强度。默认三档（Arc：关 / 中 / 超高）；
 * Thunder / Storm 使用探测到的档位。
 */
export function resolveChatReasoningTier(ratio: number, levels?: ThinkingLevel[]): ChatReasoningTier {
  const list = levels?.length ? levels : arcLevels();
  const fallback = defaultThinkingRatio(list);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : fallback));
  const percent = Math.round(clamped * 100);
  const level = resolveThinkingLevel(clamped, list);
  return {
    ratio: clamped,
    percent,
    modelRole: 'small',
    smallThinking: toLegacySmallThinking(level.id),
    thinkingId: level.id
  };
}

export function isChatMaxThinking(ratio: number, levels?: ThinkingLevel[]): boolean {
  const list = levels?.length ? levels : arcLevels();
  if (!list.length) return false;
  return resolveThinkingLevel(ratio, list).id === list[list.length - 1]!.id;
}

export function toLegacySmallThinking(thinkingId: string): ChatSmallThinkingMode {
  if (thinkingId === 'off' || thinkingId === 'none' || thinkingId === 'low' || thinkingId === 'minimal') {
    return thinkingId === 'off' || thinkingId === 'none' ? 'off' : 'medium';
  }
  if (thinkingId === 'medium') return 'medium';
  return 'xhigh';
}

/**
 * 旧 Thunder 开关：仅兼容历史会话。新对话用 chat_model。
 */
export function parseChatThunder(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

export function resolveChatModelRole(input: {
  thunder?: unknown;
  modelRole?: unknown;
  chatModel?: unknown;
  smallThinking?: ChatSmallThinkingMode;
}): ModelRole {
  const chat = parseChatModelId(input.chatModel);
  if (chat === 'storm') return 'storm';
  if (chat === 'thunder') return 'large';
  if (chat === 'arc') return 'small';
  const wantsLarge = parseChatThunder(input.thunder) || input.modelRole === 'large';
  if (wantsLarge) return 'large';
  if (input.modelRole === 'storm') return 'storm';
  return 'small';
}

export function parseChatSmallThinking(value: unknown): ChatSmallThinkingMode | null {
  if (value === 'off' || value === 'medium' || value === 'xhigh') return value;
  if (value === 'low') return 'off';
  return null;
}

export type LockedChatRunSettings = {
  locked: boolean;
  reasoningRatio: number;
  smallThinking: ChatSmallThinkingMode;
  thinkingId: ChatThinkingId;
  modelRole: ModelRole;
  chatModel: ChatModelId;
};

function chatModelFromLegacy(input: {
  thunder?: unknown;
  modelRole?: unknown;
  chatModel?: unknown;
}): ChatModelId {
  const direct = parseChatModelId(input.chatModel);
  if (direct) return direct;
  if (input.modelRole === 'storm' || parseChatModelId(input.modelRole) === 'storm') return 'storm';
  if (parseChatThunder(input.thunder) || input.modelRole === 'large') return 'thunder';
  return 'arc';
}

/**
 * 会话一旦有消息，思考档和模型以落库值为准，忽略后续请求改档。
 */
export function resolveLockedChatRunSettings(input: {
  hasMessages: boolean;
  storedRatio?: number | null;
  storedThunder?: unknown;
  storedChatModel?: unknown;
  requestedRatio?: unknown;
  requestedThunder?: unknown;
  requestedModelRole?: unknown;
  requestedChatModel?: unknown;
  requestedSmallThinking?: unknown;
  requestedThinkingId?: unknown;
  levels?: ThinkingLevel[];
}): LockedChatRunSettings {
  const levels = input.levels?.length ? input.levels : undefined;
  const requestedRatio = snapChatReasoningRatio(
    input.requestedRatio == null ? DEFAULT_CHAT_REASONING_RATIO : Number(input.requestedRatio),
    levels
  );
  if (!input.hasMessages) {
    const chatModel = chatModelFromLegacy({
      chatModel: input.requestedChatModel,
      thunder: input.requestedThunder,
      modelRole: input.requestedModelRole
    });
    const smallThinking =
      parseChatSmallThinking(input.requestedSmallThinking)
      ?? resolveChatReasoningTier(requestedRatio, levels).smallThinking;
    const thinkingId = typeof input.requestedThinkingId === 'string' && input.requestedThinkingId.trim()
      ? input.requestedThinkingId.trim()
      : resolveChatReasoningTier(requestedRatio, levels).thinkingId;
    return {
      locked: false,
      reasoningRatio: requestedRatio,
      smallThinking,
      thinkingId,
      chatModel,
      modelRole: resolveChatModelRole({
        chatModel,
        thunder: input.requestedThunder,
        modelRole: input.requestedModelRole,
        smallThinking
      })
    };
  }
  const reasoningRatio = input.storedRatio == null
    ? requestedRatio
    : snapChatReasoningRatio(Number(input.storedRatio), levels);
  const smallThinking = resolveChatReasoningTier(reasoningRatio, levels).smallThinking;
  const chatModel = chatModelFromLegacy({
    chatModel: input.storedChatModel,
    thunder: input.storedThunder,
    modelRole: undefined
  });
  return {
    locked: true,
    reasoningRatio,
    smallThinking,
    thinkingId: resolveChatReasoningTier(reasoningRatio, levels).thinkingId,
    chatModel,
    modelRole: resolveChatModelRole({
      chatModel,
      thunder: input.storedThunder,
      smallThinking
    })
  };
}

export function defaultChatThinkingRatio(chatModel: ChatModelId = 'arc'): number {
  return defaultThinkingRatio(fallbackThinkingLevels(chatModel));
}

export {
  fallbackThinkingLevels,
  resolveThinkingLevel,
  snapThinkingIdToLevels,
  thinkingStops
};
export type { ThinkingLevel };
