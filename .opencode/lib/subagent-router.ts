import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type TaskChatModelId = 'arc' | 'thunder' | 'storm';
export type TaskThinkingId = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

export type RouterTier = {
  id: string;
  enabled: boolean;
  title: string;
  when: string;
  model: TaskChatModelId;
  thinking: string;
};

export type SubagentRouterConfig = {
  enabled: boolean;
  defaultModel: TaskChatModelId;
  defaultThinking: string;
  routerTimeoutMs: number;
  tiers: RouterTier[];
};

export type RouterDecision = {
  model: TaskChatModelId;
  thinking: TaskThinkingId;
  tierId: string | null;
  tierTitle: string | null;
  source: 'router' | 'cache' | 'default';
};

export const DEFAULT_ROUTER_TIER_ID = '__default__';

export const BUILTIN_ROUTER_TIERS: RouterTier[] = [
  {
    id: 'lookup',
    enabled: true,
    title: '取数核验',
    when: '指令明确、路径唯一的执行型子任务：按给定条件读文件、检索语料、抽取字段、转换格式、核对一条事实。不需要权衡取舍，也不需要子代理自己拆解步骤。',
    model: 'arc',
    thinking: 'medium'
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

const THINKING_IDS = new Set(['off', 'none', 'low', 'medium', 'high', 'xhigh']);
const ARC_THINKING_IDS = new Set(['off', 'medium', 'xhigh']);
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 256;
const TASK_TEXT_LIMIT = 3_000;

const decisionCache = new Map<string, { expiresAt: number; value: RouterDecision }>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseModel(value: unknown, fallback: TaskChatModelId = 'thunder'): TaskChatModelId {
  const raw = String(value || '').trim().toLowerCase();
  const slash = raw.split('/').pop() || raw;
  if (slash === 'arc' || slash === 'small') return 'arc';
  if (slash === 'thunder' || slash === 'large') return 'thunder';
  if (slash === 'storm') return 'storm';
  return fallback;
}

function parseThinking(value: unknown, fallback = 'medium'): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'none' || raw === 'disabled') return 'off';
  return THINKING_IDS.has(raw) ? raw : fallback;
}

/** Arc 只有 关/中/超高。高落到超高；关和低不低于中。 */
function snapThinking(model: TaskChatModelId, thinking: string): TaskThinkingId {
  const id = parseThinking(thinking, 'medium');
  if (model !== 'arc') return id as TaskThinkingId;
  if (id === 'xhigh' || id === 'high') return 'xhigh';
  return 'medium';
}

function parseTier(raw: unknown, index: number): RouterTier {
  const row = asRecord(raw) || {};
  return {
    id: String(row.id || `tier-${index + 1}`),
    enabled: row.enabled !== false,
    title: String(row.title || `档位 ${index + 1}`),
    when: String(row.when || '').trim(),
    model: parseModel(row.model),
    thinking: typeof row.thinking === 'string' ? String(row.thinking).trim().toLowerCase() : ''
  };
}

function mergeRouterTiers(source: unknown[] | null): RouterTier[] {
  const configured = source?.map((item, index) => parseTier(item, index)) || [];
  const customById = new Map(configured.map((tier) => [tier.id, tier]));
  const tiers = BUILTIN_ROUTER_TIERS.map((tier) => ({ ...(customById.get(tier.id) || tier) }));
  const builtinIds = new Set(BUILTIN_ROUTER_TIERS.map((tier) => tier.id));
  for (const tier of configured) {
    if (!builtinIds.has(tier.id)) tiers.push(tier);
  }
  return tiers;
}

export function normalizeSubagentRouterConfig(raw: unknown): SubagentRouterConfig {
  const row = asRecord(raw) || {};
  const legacyRules = Array.isArray(row.rules)
    ? row.rules.filter((item) => asRecord(item)?.scope !== 'chat')
    : null;
  const source = Array.isArray(row.tiers) ? row.tiers : legacyRules;
  const timeout = Number(row.routerTimeoutMs);
  return {
    enabled: row.enabled !== false,
    defaultModel: parseModel(row.defaultModel),
    defaultThinking: parseThinking(row.defaultThinking, 'medium'),
    routerTimeoutMs: Number.isFinite(timeout)
      ? Math.min(30_000, Math.max(1_500, Math.round(timeout)))
      : 6_000,
    tiers: mergeRouterTiers(Array.isArray(source) ? source : null)
  };
}

function configCandidates(): string[] {
  const names = ['subagent-router.json', 'classifier.json'];
  const files: string[] = [];
  let here = '';
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // bun/node without import.meta.url
  }
  for (const name of names) {
    if (here) files.push(path.join(here, '..', name));
    files.push(path.join(process.cwd(), '.opencode', name));
    files.push(path.join(process.cwd(), name));
  }
  return files;
}

export function loadSubagentRouterConfig(): SubagentRouterConfig | null {
  for (const file of configCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      return normalizeSubagentRouterConfig(parsed);
    } catch {
      continue;
    }
  }
  return null;
}

export function activeTiers(config: SubagentRouterConfig): RouterTier[] {
  return config.tiers.filter((tier) => tier.enabled && tier.when.trim());
}

export function defaultDecision(
  config: SubagentRouterConfig,
  source: RouterDecision['source'] = 'default'
): RouterDecision {
  return {
    model: config.defaultModel,
    thinking: snapThinking(config.defaultModel, config.defaultThinking),
    tierId: null,
    tierTitle: null,
    source
  };
}

export function decisionForTier(
  config: SubagentRouterConfig,
  tierId: string,
  source: RouterDecision['source'] = 'router'
): RouterDecision | null {
  const tier = activeTiers(config).find((item) => item.id === tierId);
  if (!tier) return null;
  return {
    model: tier.model,
    thinking: snapThinking(tier.model, tier.thinking || config.defaultThinking),
    tierId: tier.id,
    tierTitle: tier.title,
    source
  };
}

export function buildRouterMessages(
  config: SubagentRouterConfig,
  input: { agent: string; text: string }
) {
  const tiers = activeTiers(config);
  const catalog = tiers
    .map((tier, index) => `${index + 1}. id=${tier.id}｜${tier.title}\n   ${tier.when}`)
    .join('\n');
  const system = [
    '你是子任务难度分级器。父代理要派一个子代理去做下面这件事，你判断这件事本身有多难，选一个档位。',
    '判断依据是任务的性质：它要不要子代理自己拆解步骤、要不要权衡取舍、要不要反复试错、一次做不对的代价有多大。',
    '不要因为文字里出现了某个词就选档；也不要因为描述长就选高档。描述短但要求自己想办法的，仍属高档。',
    `只有真正符合判据才能选择对应档位；若没有任何档位符合，必须选择 id=${DEFAULT_ROUTER_TIER_ID}，由系统使用默认档。`,
    '',
    '可选档位：',
    catalog,
    `${activeTiers(config).length + 1}. id=${DEFAULT_ROUTER_TIER_ID}｜默认档\n   上述判据都不匹配时使用设置里的默认模型和思考档。`,
    '',
    '只输出一行 JSON，形如 {"tier":"<档位id>"}，不要解释，不要代码块。'
  ].join('\n');
  const body = String(input.text || '').trim().slice(0, TASK_TEXT_LIMIT);
  const user = [
    input.agent ? `子代理：${input.agent}` : '子代理：未指定',
    '子任务：',
    body || '（无描述）'
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

export function parseRouterChoice(config: SubagentRouterConfig, text: string): RouterDecision | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const jsonMatch = raw.match(/\{[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = asRecord(JSON.parse(jsonMatch[0]));
      const tierId = String(parsed?.tier || parsed?.id || parsed?.tier_id || '').trim();
      if (tierId) {
        if (tierId.toLowerCase() === DEFAULT_ROUTER_TIER_ID) {
          return defaultDecision(config, 'router');
        }
        const hit = decisionForTier(config, tierId);
        if (hit) return hit;
      }
    } catch {
      // 落到下面的宽松匹配
    }
  }
  const lower = raw.toLowerCase();
  if (lower.includes(DEFAULT_ROUTER_TIER_ID)) return defaultDecision(config, 'router');
  for (const tier of activeTiers(config)) {
    if (lower.includes(tier.id.toLowerCase())) return decisionForTier(config, tier.id);
  }
  return null;
}

function gatewayChatUrl() {
  const base = String(process.env.KNOWLEDGE_QA_BASE_URL || '').trim().replace(/\/$/, '');
  if (base) return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  return `http://127.0.0.1:${process.env.LLM_GATEWAY_PORT || 4098}/v1/chat/completions`;
}

function cacheKey(config: SubagentRouterConfig, input: { agent: string; text: string }) {
  const signature = activeTiers(config).map((tier) => `${tier.id}:${tier.model}:${tier.thinking}`).join('|');
  const body = String(input.text || '').replace(/\s+/g, ' ').trim().slice(0, TASK_TEXT_LIMIT);
  return `${signature}\u0000${input.agent}\u0000${body}`;
}

function readCache(key: string): RouterDecision | null {
  const hit = decisionCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    decisionCache.delete(key);
    return null;
  }
  return { ...hit.value, source: 'cache' };
}

function writeCache(key: string, value: RouterDecision) {
  if (decisionCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = decisionCache.keys().next().value;
    if (oldest) decisionCache.delete(oldest);
  }
  decisionCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

/**
 * 用本地 Arc 做一次极短的分级调用。网关不通或超时就回落默认档，
 * 绝不让路由失败挡住子代理派发。
 */
export async function routeSubagentTask(input: {
  agent: string;
  text: string;
  config?: SubagentRouterConfig | null;
}): Promise<RouterDecision> {
  const config = input.config ?? loadSubagentRouterConfig();
  if (!config || !config.enabled) {
    return config ? defaultDecision(config) : {
      model: 'thunder',
      thinking: 'medium',
      tierId: null,
      tierTitle: null,
      source: 'default'
    };
  }
  const tiers = activeTiers(config);
  if (!tiers.length) return defaultDecision(config);
  if (!String(input.text || '').trim()) return defaultDecision(config);

  const key = cacheKey(config, input);
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const response = await fetch(gatewayChatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model: 'arc',
        messages: buildRouterMessages(config, input),
        temperature: 0,
        max_tokens: 48,
        stream: false
      }),
      signal: AbortSignal.timeout(config.routerTimeoutMs)
    });
    if (!response.ok) return defaultDecision(config);
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => String(asRecord(part)?.text || '')).join('')
        : '';
    const decision = parseRouterChoice(config, text);
    if (!decision) return defaultDecision(config);
    writeCache(key, decision);
    return decision;
  } catch {
    return defaultDecision(config);
  }
}
