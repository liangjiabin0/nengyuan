/**
 * Tap OpenAI-compatible SSE as it leaves the gateway so the chat UI can show
 * small-model reasoning at the same wall-clock speed as the upstream model.
 * OpenCode 1.18 buffers those tokens and only later dumps message.part.delta.
 */

export function extractReasoningDeltasFromSse(eventText) {
  const deltas = [];
  const lines = String(eventText || '').split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const delta = parsed?.choices?.[0]?.delta;
    if (!delta || typeof delta !== 'object') continue;
    const seen = new Set();
    for (const key of ['reasoning', 'reasoning_content']) {
      const value = delta[key];
      if (typeof value === 'string' && value && !seen.has(value)) {
        seen.add(value);
        deltas.push(value);
      }
    }
  }
  return deltas;
}

export function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

export class ThoughtLeaseHub {
  constructor() {
    this.leases = [];
  }

  add(conversationId, sessionId, send) {
    const lease = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId: String(conversationId || '').trim(),
      sessionId: String(sessionId || '').trim(),
      send,
      alive: true
    };
    this.leases.push(lease);
    return () => {
      lease.alive = false;
      this.leases = this.leases.filter((item) => item !== lease);
    };
  }

  publish(conversationId, text, sessionId = '') {
    const targetConversationId = String(conversationId || '').trim();
    const targetSessionId = String(sessionId || '').trim();
    const value = String(text || '');
    if (!targetConversationId || !targetSessionId || !value) return false;
    const lease = this.leases.find((item) => (
      item.alive
      && item.conversationId === targetConversationId
      && item.sessionId === targetSessionId
    ));
    if (!lease) return false;
    try {
      lease.send(value, targetSessionId);
      return true;
    } catch {
      lease.alive = false;
      return false;
    }
  }

  get size() {
    return this.leases.filter((item) => item.alive).length;
  }
}
