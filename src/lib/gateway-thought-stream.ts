import http from 'node:http';
import { URL } from 'node:url';

export const GATEWAY_THOUGHT_ID = 'gateway-live';

/** Parent OpenCode reasoning is a delayed duplicate of the gateway tap. Child sessions are not. */
export function shouldDropOpenCodeReasoning(input: {
  reasoningId: string;
  gatewayThoughtChars: number;
  originSessionId?: string;
  parentSessionId: string;
}) {
  if (input.reasoningId === GATEWAY_THOUGHT_ID) return false;
  if (input.gatewayThoughtChars <= 0) return false;
  if (input.originSessionId && input.originSessionId !== input.parentSessionId) return false;
  return true;
}

function gatewayOrigin(gatewayUrl?: string) {
  const raw = String(gatewayUrl || '').trim();
  if (raw) return raw.replace(/\/v1\/?$/, '');
  const port = process.env.LLM_GATEWAY_PORT || '4098';
  return `http://127.0.0.1:${port}`;
}

export async function subscribeGatewayThoughts(input: {
  gatewayUrl?: string;
  conversationId?: string;
  onDelta: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<{ close: () => void } | null> {
  const origin = gatewayOrigin(input.gatewayUrl);
  const conversationId = encodeURIComponent(input.conversationId || '');
  const target = new URL(`${origin}/internal/thought-stream?conversationId=${conversationId}`);

  return await new Promise((resolve) => {
    let settled = false;
    let pending = '';
    let pump: Promise<void> = Promise.resolve();
    const req = http.get({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      headers: {
        Accept: 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        if (!settled) {
          settled = true;
          resolve(null);
        }
        return;
      }
      res.setEncoding('utf8');
      try {
        res.socket?.setNoDelay?.(true);
      } catch {
        // ignore
      }
      const consume = (block: string) => {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let parsed: { type?: string; text?: string };
          try {
            parsed = JSON.parse(payload) as { type?: string; text?: string };
          } catch {
            continue;
          }
          if (parsed.type === 'delta' && parsed.text) {
            pump = pump.then(() => input.onDelta(parsed.text || '')).catch(() => undefined);
          }
        }
      };
      res.on('data', (chunk: string) => {
        pending += String(chunk || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let sep = pending.indexOf('\n\n');
        while (sep >= 0) {
          const block = pending.slice(0, sep);
          pending = pending.slice(sep + 2);
          consume(block);
          sep = pending.indexOf('\n\n');
        }
      });
      res.on('end', () => {
        if (pending.trim()) consume(pending);
      });
      if (!settled) {
        settled = true;
        resolve({
          close: () => {
            try {
              req.destroy();
            } catch {
              // ignore
            }
          }
        });
      }
    });
    req.on('error', () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    const onAbort = () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => {
      input.signal?.removeEventListener('abort', onAbort);
    });
  });
}
