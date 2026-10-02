/**
 * 按 OpenCode 会话记住这次请求实际落到哪一档。
 *
 * 两个用途：
 * - 粘滞：子代理的档位只写在首轮 prompt 的 [[ai4es-model]] 标记里，压缩或裁剪掉之后
 *   后续轮次会掉回 Arc。标记认过一次就把该会话钉住，后面没标记也照原档走。
 * - 回报：应用要在对话气泡和子代理节点上标出真实用的模型和思考档，按会话 id 来这里取。
 */

export const SESSION_ROUTING_PATH = '/ai4es/session-routing';
export const SESSION_ID_HEADER = 'x-ai4es-session-id';

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_MAX_ENTRIES = 2_000;

/** sessionId -> { role, thinking, pinned, updatedAt } */
const sessions = new Map();

function prune() {
  const deadline = Date.now() - SESSION_TTL_MS;
  for (const [id, entry] of sessions) {
    if (entry.updatedAt < deadline) sessions.delete(id);
  }
  while (sessions.size > SESSION_MAX_ENTRIES) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function sessionIdFromRequest(req) {
  const raw = req?.headers?.[SESSION_ID_HEADER];
  return String(Array.isArray(raw) ? raw[0] : raw || '').trim();
}

export function pinnedSessionRouting(sessionId) {
  if (!sessionId) return null;
  const entry = sessions.get(sessionId);
  if (!entry || !entry.pinned) return null;
  if (entry.updatedAt < Date.now() - SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return entry;
}

/**
 * @param pinned 档位来自请求头或 prompt 标记（也就是子代理路由的决定），
 *               而不是 body.model 这种每轮都在的默认值，才值得钉住。
 */
export function rememberSessionRouting(sessionId, { role, thinking, pinned = false }) {
  if (!sessionId || !role || role === 'image') return;
  const previous = sessions.get(sessionId);
  // Map 靠插入顺序做 LRU，重写前先摘掉旧键。
  sessions.delete(sessionId);
  sessions.set(sessionId, {
    role,
    thinking: thinking || previous?.thinking || null,
    pinned: pinned || previous?.pinned === true,
    updatedAt: Date.now()
  });
  prune();
}

export function sessionRoutingSnapshot(ids) {
  const out = {};
  const deadline = Date.now() - SESSION_TTL_MS;
  for (const id of ids) {
    const entry = sessions.get(id);
    if (!entry || entry.updatedAt < deadline) continue;
    out[id] = { role: entry.role, thinking: entry.thinking, updatedAt: entry.updatedAt };
  }
  return out;
}

export function handleSessionRoutingRequest(req, res) {
  if (req.method !== 'GET') return false;
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== SESSION_ROUTING_PATH) return false;
  const ids = String(url.searchParams.get('ids') || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ sessions: sessionRoutingSnapshot(ids) }));
  return true;
}
