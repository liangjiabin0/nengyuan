import { getModelEndpoint, type EndpointRole, type ModelEndpointSettings } from './config';
import {
  type ChatModelId,
  CHAT_MODEL_IDS,
  endpointRoleForChatModel,
  normalizeChatModelId
} from './model-ids';
import { fetchModelsList, parseApiFormat } from './openai-anthropic-compat';
import {
  fallbackThinkingLevels,
  THINKING_LABELS,
  type ThinkingCatalog,
  type ThinkingLevel
} from './thinking-levels-core';

export type { ThinkingCatalog, ThinkingLevel };
export {
  ARC_THINKING_LEVELS,
  CLOUD_THINKING_LEVELS,
  defaultThinkingRatio,
  fallbackThinkingLevels,
  resolveThinkingLevel,
  snapThinkingRatio,
  stepThinkingRatio,
  thinkingStops
} from './thinking-levels-core';

const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { expiresAt: number; value: ThinkingCatalog }>();

function normalizeEffortId(value: string) {
  const raw = value.trim().toLowerCase();
  if (raw === 'none' || raw === 'off' || raw === 'disabled') return 'off';
  if (raw === 'x-high' || raw === 'extra_high' || raw === 'extra-high') return 'xhigh';
  return raw;
}

function levelFromEffort(id: string): ThinkingLevel {
  const key = normalizeEffortId(id);
  const meta = THINKING_LABELS[key] || { label: key, description: `${key} 思考档` };
  if (key === 'off') return { id: 'off', ...meta };
  return { id: key, ...meta, variant: key, effort: key };
}

function uniqueLevels(ids: string[]): ThinkingLevel[] {
  const seen = new Set<string>();
  const levels: ThinkingLevel[] = [];
  for (const id of ids) {
    const key = normalizeEffortId(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    levels.push(levelFromEffort(key));
  }
  if (!levels.some((item) => item.id === 'off')) {
    levels.unshift(levelFromEffort('off'));
  }
  levels.sort((left, right) => {
    const a = EFFORT_ORDER.indexOf(left.id);
    const b = EFFORT_ORDER.indexOf(right.id);
    return (a < 0 ? 99 : a) - (b < 0 ? 99 : b);
  });
  return levels.length ? levels : fallbackThinkingLevels('thunder');
}

function collectEffortIds(model: Record<string, unknown>): string[] {
  const found: string[] = [];
  const direct = [
    model.supported_reasoning_efforts,
    model.reasoning_efforts,
    model.supported_thinking_levels,
    (model.reasoning as { efforts?: unknown } | undefined)?.efforts,
    (model.capabilities as { reasoning_effort?: unknown } | undefined)?.reasoning_effort,
    (model.capabilities as { reasoning?: { efforts?: unknown } } | undefined)?.reasoning?.efforts
  ];
  for (const value of direct) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') found.push(item);
        else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
          found.push(String((item as { id: string }).id));
        }
      }
    }
  }
  const variants = model.variants;
  if (variants && typeof variants === 'object' && !Array.isArray(variants)) {
    found.push(...Object.keys(variants as Record<string, unknown>));
  }
  return found;
}

function catalogModels(payload: { data?: unknown[] } | unknown[]) {
  return (Array.isArray(payload) ? payload : payload.data || [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function matchCatalogModel(models: Record<string, unknown>[], wanted: string) {
  const needle = wanted.toLowerCase();
  return models.find((item) => {
    const id = String(item.id || item.name || '').toLowerCase();
    return id === needle || id.endsWith(`/${needle}`) || id.endsWith(`:${needle}`);
  }) || null;
}

async function probeEndpointLevels(endpoint: ModelEndpointSettings): Promise<ThinkingLevel[] | null> {
  if (parseApiFormat(endpoint.apiFormat) === 'anthropic') return null;
  try {
    const response = await fetchModelsList(endpoint, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const payload = await response.json() as { data?: unknown[] } | unknown[];
    const selected = matchCatalogModel(catalogModels(payload), endpoint.model);
    if (!selected) return null;
    const ids = collectEffortIds(selected);
    if (!ids.length) return null;
    return uniqueLevels(ids);
  } catch {
    return null;
  }
}

export async function detectThinkingLevels(
  modelInput: ChatModelId | EndpointRole | string = 'arc'
): Promise<ThinkingCatalog> {
  const model = normalizeChatModelId(modelInput);
  const endpointRole = endpointRoleForChatModel(model);
  const endpoint = getModelEndpoint(endpointRole);
  const cacheKey = `${model}:${endpoint.baseUrl}:${endpoint.model}:${endpoint.apiFormat || 'openai'}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let levels: ThinkingLevel[] | null = null;
  if (model !== 'arc') {
    levels = await probeEndpointLevels(endpoint);
  }
  const value: ThinkingCatalog = {
    model,
    levels: levels && levels.length ? levels : fallbackThinkingLevels(model),
    source: levels && levels.length ? 'probe' : 'fallback',
    detectedAt: new Date().toISOString()
  };
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function detectAllThinkingLevels(): Promise<Record<ChatModelId, ThinkingCatalog>> {
  const catalogs = await Promise.all(CHAT_MODEL_IDS.map((model) => detectThinkingLevels(model)));
  return Object.fromEntries(catalogs.map((item) => [item.model, item])) as Record<ChatModelId, ThinkingCatalog>;
}
