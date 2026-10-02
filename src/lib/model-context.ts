import fs from 'node:fs';
import path from 'node:path';
import { getModelEndpoint, type ModelRole } from './config';
import { LOCAL_SMALL_CONTEXT_TOKENS } from './local-llm-extras';
import {
  OPENCODE_LARGE_LEGACY_ALIAS,
  OPENCODE_LARGE_MODEL_ALIAS,
  OPENCODE_SMALL_LEGACY_ALIAS,
  OPENCODE_SMALL_MODEL_ALIAS,
  OPENCODE_STORM_MODEL_ALIAS,
  resolveOpenCodeModelId
} from './model-ids';

export type ModelContextInfo = {
  role: ContextRole;
  model: string;
  contextWindow: number;
  source: 'opencode-config' | 'model-endpoint' | 'fallback';
  detectedAt: string;
};

/** 【按线上版本补回】storm 为第三档远程模型 */
type ContextRole = 'small' | 'large' | 'storm';

type CachedContextInfo = {
  expiresAt: number;
  value: ModelContextInfo;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedContextInfo>();

function modelsUrl(baseUrl: string) {
  const normalized = baseUrl.trim().replace(/\/$/, '');
  return normalized.endsWith('/v1') ? `${normalized}/models` : `${normalized}/v1/models`;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function readContextWindow(model: Record<string, unknown>) {
  const directKeys = [
    'max_model_len',
    'max_context_length',
    'context_length',
    'context_window',
    'max_sequence_length',
    'max_position_embeddings',
    'max_input_tokens',
    'max_tokens',
    'n_ctx'
  ];
  for (const key of directKeys) {
    const found = positiveInteger(model[key]);
    if (found) return found;
  }

  for (const nestedKey of ['capabilities', 'metadata', 'config']) {
    const nested = model[nestedKey];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    for (const key of directKeys) {
      const found = positiveInteger((nested as Record<string, unknown>)[key]);
      if (found) return found;
    }
  }
  return null;
}

function fallbackContextWindow(role: ContextRole, model: string) {
  if (role === 'small') return LOCAL_SMALL_CONTEXT_TOKENS;
  if (/gpt-6-astra|\bastra\b/i.test(model)) return 272_000;
  if (/gpt-6-sol/i.test(model)) return 919_387;
  if (/gpt-4\.1|gpt-5/i.test(model)) return 1_000_000;
  if (/claude/i.test(model)) return 200_000;
  if (/deepseek/i.test(model)) return 128_000;
  if (/gemini/i.test(model)) return 1_000_000;
  return 128_000;
}

function opencodePath() {
  return path.join(process.cwd(), 'opencode.json');
}

function readOpenCodeConfig() {
  return JSON.parse(fs.readFileSync(opencodePath(), 'utf8').replace(/^\uFEFF/, '')) as {
    provider?: Record<string, {
      models?: Record<string, { limit?: { context?: unknown; output?: unknown } }>;
    }>;
  };
}

function configuredOpenCodeContextWindow(role: ContextRole) {
  try {
    const config = readOpenCodeConfig();
    const models = config.provider?.gateway?.models;
    for (const modelId of contextAliases(role)) {
      const found = positiveInteger(models?.[modelId]?.limit?.context);
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  }
}

function contextAliases(role: ContextRole) {
  if (role === 'storm') return [OPENCODE_STORM_MODEL_ALIAS];
  if (role === 'large') return [OPENCODE_LARGE_MODEL_ALIAS, OPENCODE_LARGE_LEGACY_ALIAS];
  return [OPENCODE_SMALL_MODEL_ALIAS, OPENCODE_SMALL_LEGACY_ALIAS];
}

function gatewayModelsUrl() {
  const fromEnv = String(process.env.KNOWLEDGE_QA_BASE_URL || '').trim();
  if (fromEnv) return modelsUrl(fromEnv);
  return `http://127.0.0.1:${process.env.LLM_GATEWAY_PORT || 4098}/v1/models`;
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

async function detectGatewayCatalog(role: ContextRole) {
  const publicId = resolveOpenCodeModelId(role);
  const response = await fetch(gatewayModelsUrl(), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) return null;
  const payload = await response.json() as { data?: unknown[] } | unknown[];
  const selected = matchCatalogModel(catalogModels(payload), publicId);
  if (!selected) return null;
  return readContextWindow(selected);
}

function persistOpenCodeContextWindow(role: ContextRole, contextWindow: number) {
  try {
    const config = readOpenCodeConfig();
    const models = config.provider?.gateway?.models;
    if (!models) return;
    let changed = false;
    for (const alias of contextAliases(role)) {
      const model = models[alias];
      if (!model) continue;
      if (positiveInteger(model.limit?.context) === contextWindow && positiveInteger(model.limit?.output)) continue;
      model.limit = {
        ...(model.limit || {}),
        context: contextWindow,
        output: positiveInteger(model.limit?.output) || 32_768
      };
      changed = true;
    }
    if (!changed) return;
    fs.writeFileSync(opencodePath(), `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // Occupancy still uses the live endpoint window if this write fails.
  }
}

export async function detectModelContext(
  roleInput: ModelRole | 'thunder' = 'small'
): Promise<ModelContextInfo> {
  const role: ContextRole = roleInput === 'storm'
    ? 'storm'
    : roleInput === 'large' || roleInput === 'thunder' ? 'large' : 'small';
  const endpoint = getModelEndpoint(role);
  const publicModel = resolveOpenCodeModelId(role);
  const cacheKey = `${role}:${publicModel}:${endpoint.baseUrl}:${endpoint.model}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const configuredContextWindow = configuredOpenCodeContextWindow(role);
  let endpointContextWindow: number | null = null;
  try {
    endpointContextWindow = await detectGatewayCatalog(role);
  } catch {
    // 网关未就绪时改探上游，但对外模型名仍用 thunder / arc。
  }
  if (!endpointContextWindow) {
    try {
      const headers = new Headers({ Accept: 'application/json' });
      if (endpoint.apiKey) headers.set('Authorization', `Bearer ${endpoint.apiKey}`);
      const response = await fetch(modelsUrl(endpoint.baseUrl), {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000)
      });
      if (response.ok) {
        const payload = await response.json() as { data?: unknown[] } | unknown[];
        const selected = matchCatalogModel(catalogModels(payload), endpoint.model);
        if (selected) endpointContextWindow = readContextWindow(selected);
      }
    } catch {
      // The UI still receives a conservative configured fallback when discovery is unavailable.
    }
  }

  if (endpointContextWindow) {
    persistOpenCodeContextWindow(role, endpointContextWindow);
  }

  const contextWindow = endpointContextWindow
    || configuredContextWindow
    || fallbackContextWindow(role, endpoint.model);
  const value: ModelContextInfo = {
    role,
    model: publicModel,
    contextWindow,
    source: endpointContextWindow
      ? 'model-endpoint'
      : configuredContextWindow
        ? 'opencode-config'
        : 'fallback',
    detectedAt: new Date().toISOString()
  };
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}
