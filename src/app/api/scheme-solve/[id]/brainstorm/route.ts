import { requireUser } from '@/lib/auth/request';
import { runSchemeBrainstormJob } from '@/lib/scheme-solve/brainstorm';
import {
  assertSchemeOwner,
  getSchemeSession,
  getSchemeSnapshot,
  setSchemeSessionStatus
} from '@/lib/scheme-solve/store';
import type { RuntimeAgentStep } from '@/lib/opencode/types';

export const runtime = 'nodejs';
export const maxDuration = 900;
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

function encodeEvent(event: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) {
    return Response.json({ error: '方案不存在。' }, { status: 404 });
  }
  if (!ownership.allowed) {
    return Response.json({ error: '无权访问该方案。' }, { status: 403 });
  }
  const session = await getSchemeSession(id);
  if (!session) return Response.json({ error: '方案不存在。' }, { status: 404 });
  if (session.status === 'brainstorming' || session.status === 'researching') {
    return Response.json({ error: '已有任务进行中。' }, { status: 409 });
  }

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const enqueue = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encodeEvent(event));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => enqueue({ type: 'status', detail: '头脑风暴进行中…' }), 8000);
      enqueue({ type: 'status', detail: '正在启动头脑风暴' });

      void (async () => {
        try {
          const payload = await runSchemeBrainstormJob(id, {
            onStatus: (detail) => enqueue({ type: 'status', detail }),
            onStep: (step: RuntimeAgentStep) => enqueue({ type: 'agent_step', step }),
            signal: request.signal
          });
          const snapshot = await getSchemeSnapshot(id);
          enqueue({ type: 'ideas', ...payload });
          enqueue({ type: 'session', session: snapshot });
          enqueue({ type: 'done' });
        } catch (error) {
          const message = error instanceof Error ? error.message : '头脑风暴失败。';
          await setSchemeSessionStatus(id, 'failed', { detail: message, error: message });
          enqueue({ type: 'error', error: message });
        } finally {
          clearInterval(heartbeat);
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      })();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
