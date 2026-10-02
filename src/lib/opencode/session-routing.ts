import { chatModelFromEndpointRole, type ChatModelId } from '../model-ids';

/**
 * 子代理落在哪一档是 OpenCode 插件在派 task 时定的，换模型由本机 Gateway 按
 * prompt 标记完成，OpenCode 自己上报的 modelID 始终是 Agent 配置里那个。
 * 所以真实档位只能回头问 Gateway：它按 x-ai4es-session-id 记着每个会话实际走了哪一档。
 */

export type SessionRouting = {
  model: ChatModelId;
  thinking: string | null;
};

type GatewayRoutingRow = {
  role?: unknown;
  thinking?: unknown;
};

const LOOKUP_TIMEOUT_MS = 1_500;
const HIT_TTL_MS = 30 * 60 * 1000;
/** 会话可能只是还没发出第一次模型请求，很快就会有；查空只短暂记住，别把标注卡死。 */
const MISS_TTL_MS = 5_000;
const CACHE_MAX_ENTRIES = 512;

const cache = new Map<string, { expiresAt: number; value: SessionRouting | null }>();
const inFlight = new Map<string, Promise<void>>();

function gatewayOrigin() {
  const base = String(process.env.KNOWLEDGE_QA_BASE_URL || '').trim();
  if (base) return base.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `http://127.0.0.1:${process.env.LLM_GATEWAY_PORT || 4098}`;
}

function readCache(sessionId: string) {
  const hit = cache.get(sessionId);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(sessionId);
    return undefined;
  }
  return hit.value;
}

function writeCache(sessionId: string, value: SessionRouting | null) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(sessionId, {
    expiresAt: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS),
    value
  });
}

function parseRow(row: GatewayRoutingRow | undefined): SessionRouting | null {
  const role = String(row?.role || '').trim().toLowerCase();
  if (role !== 'small' && role !== 'large' && role !== 'storm') return null;
  const thinking = String(row?.thinking || '').trim().toLowerCase();
  return {
    model: chatModelFromEndpointRole(role),
    thinking: thinking || null
  };
}

async function loadFromGateway(sessionIds: string[]) {
  try {
    const url = `${gatewayOrigin()}/ai4es/session-routing?ids=${encodeURIComponent(sessionIds.join(','))}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
    });
    const payload = response.ok
      ? await response.json() as { sessions?: Record<string, GatewayRoutingRow> }
      : {};
    for (const id of sessionIds) {
      writeCache(id, parseRow(payload.sessions?.[id]));
    }
  } catch {
    // 网关没起来或超时：记一次短空档，不标注即可，绝不挡住对话
    for (const id of sessionIds) writeCache(id, null);
  }
}

/**
 * 同一批会话只发一次请求；并发的调用方共享同一个 in-flight Promise。
 */
export async function fetchSessionRouting(sessionIds: string[]): Promise<Map<string, SessionRouting>> {
  const wanted = [...new Set(sessionIds.filter(Boolean))];
  const missing = wanted.filter((id) => readCache(id) === undefined && !inFlight.has(id));
  if (missing.length) {
    const pending = loadFromGateway(missing).finally(() => {
      for (const id of missing) inFlight.delete(id);
    });
    for (const id of missing) inFlight.set(id, pending);
  }
  await Promise.all(wanted.map((id) => inFlight.get(id)).filter(Boolean));

  const out = new Map<string, SessionRouting>();
  for (const id of wanted) {
    const value = readCache(id);
    if (value) out.set(id, value);
  }
  return out;
}

/** 只把缓存暖起来，不等结果。 */
export function prefetchSessionRouting(sessionIds: string[]) {
  const missing = sessionIds.filter((id) => id && readCache(id) === undefined && !inFlight.has(id));
  if (missing.length) void fetchSessionRouting(missing);
}

export function cachedSessionRouting(sessionId?: string): SessionRouting | null {
  return sessionId ? readCache(sessionId) || null : null;
}
