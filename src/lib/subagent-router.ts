import { isChatModelId, normalizeChatModelId, type ChatModelId } from './model-ids';
import { fallbackThinkingLevels, snapThinkingIdToLevels } from './thinking-levels-core';

/**
 * 父代理的模型由会话头部直接选定，不参与路由。
 * 这里只描述父代理派 task 时，子代理该落到哪一档。
 */
export type RouterTier = {
  id: string;
  enabled: boolean;
  title: string;
  /** 自然语言判据，直接喂给路由模型，不做关键词匹配 */
  when: string;
  model: ChatModelId;
  /** 空字符串表示跟随默认思考档 */
  thinking: string;
  /** 内置判据可被同 id 的用户规则覆盖，但始终保留为兜底能力。 */
  builtin?: boolean;
};

export type SubagentRouterConfig = {
  /** 关闭后所有子代理直接用默认档，不再调用路由模型 */
  enabled: boolean;
  defaultModel: ChatModelId;
  defaultThinking: string;
  /** 路由模型的等待上限，超时就回落默认档 */
  routerTimeoutMs: number;
  tiers: RouterTier[];
};

export type RouterDecisionSource = 'explicit' | 'router' | 'cache' | 'default' | 'agent-lock';

export type RouterDecision = {
  model: ChatModelId;
  thinking: string;
  tierId: string | null;
  tierTitle: string | null;
  source: RouterDecisionSource;
};

const THINKING_IDS = new Set(['off', 'none', 'low', 'medium', 'high', 'xhigh']);

export const ROUTER_TIMEOUT_MIN_MS = 1_500;
export const ROUTER_TIMEOUT_MAX_MS = 30_000;
export const ROUTER_TIMEOUT_DEFAULT_MS = 6_000;

export const DEFAULT_ROUTER_TIERS: RouterTier[] = [
  {
    id: 'lookup',
    enabled: true,
    title: '取数核验',
    when: '指令明确、路径唯一的执行型子任务：按给定条件读文件、检索语料、抽取字段、转换格式、核对一条事实。不需要权衡取舍，也不需要子代理自己拆解步骤。',
    model: 'arc',
    thinking: 'off'
  },
  {
    id: 'analyze',
    enabled: true,
    title: '综合分析',
    when: '需要判断但路径清楚的子任务：多份材料交叉综合、方案比较、机理解释、成段写作或改写、按标准审阅并给出修改意见。一般几步之内能收敛。',
    model: 'thunder',
    thinking: 'medium'
  },
  {
    id: 'deep',
    enabled: true,
    title: '长链路攻坚',
    when: '需要子代理自己拆解步骤并反复试错的子任务：论文复现、跨多文件工程改动、建模求解与调参、实验编排、复杂方案设计、要连续调用大量工具并自我纠错。',
    model: 'storm',
    thinking: 'high'
  }
];

export const DEFAULT_SUBAGENT_ROUTER_CONFIG: SubagentRouterConfig = {
  enabled: true,
  defaultModel: 'thunder',
  defaultThinking: 'medium',
  routerTimeoutMs: ROUTER_TIMEOUT_DEFAULT_MS,
  tiers: DEFAULT_ROUTER_TIERS
};

function mergeRouterTiers(source: RouterTier[] | null): RouterTier[] {
  const configured = source || [];
  const customById = new Map(configured.map((tier) => [tier.id, tier]));
  const tiers = DEFAULT_ROUTER_TIERS.map((tier) => ({
    ...(customById.get(tier.id) || tier),
    builtin: true
  }));
  const builtinIds = new Set(DEFAULT_ROUTER_TIERS.map((tier) => tier.id));
  for (const tier of configured) {
    if (!builtinIds.has(tier.id)) tiers.push({ ...tier, builtin: false });
  }
  return tiers;
}

export function normalizeThinkingId(value: unknown, fallback = 'medium'): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'none' || raw === 'disabled') return 'off';
  if (raw === 'x-high' || raw === 'extra_high' || raw === 'extra-high') return 'xhigh';
  return THINKING_IDS.has(raw) ? raw : fallback;
}

export function newTierId() {
  return `tier-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeRouterTier(raw: unknown, index = 0): RouterTier {
  const row = asRecord(raw) || {};
  return {
    id: String(row.id || '').trim() || newTierId(),
    enabled: row.enabled !== false,
    title: String(row.title || '').trim() || `档位 ${index + 1}`,
    when: String(row.when || row.description || '').trim(),
    model: normalizeChatModelId(row.model, 'thunder'),
    thinking: typeof row.thinking === 'string' ? normalizeThinkingId(row.thinking, '') : ''
  };
}

function normalizeTimeout(value: unknown): number {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return ROUTER_TIMEOUT_DEFAULT_MS;
  return Math.min(ROUTER_TIMEOUT_MAX_MS, Math.max(ROUTER_TIMEOUT_MIN_MS, Math.round(ms)));
}

/** 旧分类器配置把档位放在 rules 里，还带关键词和 chat 作用域；这里只保留语义判据。 */
export function normalizeSubagentRouterConfig(raw: unknown): SubagentRouterConfig {
  const row = asRecord(raw) || {};
  const legacyRules = Array.isArray(row.rules)
    ? row.rules.filter((item) => asRecord(item)?.scope !== 'chat')
    : null;
  const source = Array.isArray(row.tiers) ? row.tiers : legacyRules;
  const tiers = mergeRouterTiers(source?.length
    ? source.map((item, index) => normalizeRouterTier(item, index))
    : null);
  return {
    enabled: row.enabled !== false,
    defaultModel: isChatModelId(row.defaultModel)
      ? row.defaultModel
      : DEFAULT_SUBAGENT_ROUTER_CONFIG.defaultModel,
    defaultThinking: normalizeThinkingId(
      row.defaultThinking,
      DEFAULT_SUBAGENT_ROUTER_CONFIG.defaultThinking
    ),
    routerTimeoutMs: normalizeTimeout(row.routerTimeoutMs),
    tiers
  };
}

export function publicSubagentRouterConfig(config: SubagentRouterConfig): SubagentRouterConfig {
  return {
    enabled: config.enabled,
    defaultModel: config.defaultModel,
    defaultThinking: config.defaultThinking,
    routerTimeoutMs: config.routerTimeoutMs,
    tiers: config.tiers.map((tier) => ({ ...tier }))
  };
}

export function activeRouterTiers(config: SubagentRouterConfig): RouterTier[] {
  return config.tiers.filter((tier) => tier.enabled && tier.when.trim());
}

/** 档位思考档要落到该模型真实存在的档位上（Arc 只有 关/中/超高）。 */
export function snapTierThinking(model: ChatModelId, thinking: string): string {
  return snapThinkingIdToLevels(thinking, fallbackThinkingLevels(model));
}

export function defaultRouterDecision(
  config: SubagentRouterConfig,
  source: RouterDecisionSource = 'default'
): RouterDecision {
  return {
    model: config.defaultModel,
    thinking: snapTierThinking(config.defaultModel, config.defaultThinking),
    tierId: null,
    tierTitle: null,
    source
  };
}

export function decisionForTier(
  config: SubagentRouterConfig,
  tierId: string,
  source: RouterDecisionSource = 'router'
): RouterDecision | null {
  const tier = activeRouterTiers(config).find((item) => item.id === tierId);
  if (!tier) return null;
  return {
    model: tier.model,
    thinking: snapTierThinking(tier.model, tier.thinking || config.defaultThinking),
    tierId: tier.id,
    tierTitle: tier.title,
    source
  };
}

/**
 * 写进父代理系统提示的路由说明。父代理显式写 model/thinking 时直接生效，
 * 不写才交给路由模型判断。
 */
export function formatSubagentRouterHint(config: SubagentRouterConfig): string {
  if (!config.enabled) return '';
  const tiers = activeRouterTiers(config);
  if (!tiers.length) return '';
  const lines = tiers.slice(0, 8).map((tier) => {
    const thinking = snapTierThinking(tier.model, tier.thinking || config.defaultThinking);
    return `- ${tier.title}：${tier.when} → model=${tier.model} thinking=${thinking}`;
  });
  return [
    '【子代理档位优先级】先由你这个父代理根据完整上下文决定子代理的模型和思考档。你决定时，必须在 task 的 prompt 首行写 [[ai4es-model:arc|thunder|storm]]，思考档写 [[ai4es-thinking:off|low|medium|high|xhigh]]；显式决定不得被路由器改写。',
    '只有你没有明确决定时，才由路由模型参考下列内置和自定义判据兜底；这些判据是补位规则，不是对你判断的覆盖。',
    ...lines
  ].join('\n');
}
