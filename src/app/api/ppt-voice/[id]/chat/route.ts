import { z } from 'zod';
import { requireUser } from '@/lib/auth/request';
import { chatPptVoiceAssistant, publicAssistantReply } from '@/lib/ppt-voice/notes-ai';
import {
  appendPptVoiceEvent,
  appendPptVoiceMessage,
  assertPptVoiceOwner,
  getPptVoiceSnapshot,
  listPptVoiceMessages,
  listPptVoiceSlides,
  refreshPptVoiceReadyStatus,
  updatePptVoiceSlidesNotes
} from '@/lib/ppt-voice/store';

export const runtime = 'nodejs';
export const maxDuration = 600;
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const schema = z.object({
  message: z.string().trim().min(1).max(4000)
});

function encodeEvent(event: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertPptVoiceOwner(id, auth.user!.id);
  if (!ownership.exists) return Response.json({ error: '项目不存在。' }, { status: 404 });
  if (!ownership.allowed) return Response.json({ error: '无权访问该项目。' }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: '请输入问题。' }, { status: 422 });

  const history = await listPptVoiceMessages(id);
  await appendPptVoiceMessage(id, 'user', parsed.data.message);
  await appendPptVoiceEvent({ projectId: id, text: '助手开始处理对话' });

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const enqueue = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encodeEvent(event));
        } catch {
          closed = true;
        }
      };
      enqueue({
        type: 'ack',
        thought: '已收到，正在阅读幻灯片目录',
        project: await getPptVoiceSnapshot(id)
      });

      void (async () => {
        try {
          let lastThoughtAt = 0;
          let lastThought = '';
          const result = await chatPptVoiceAssistant({
            projectId: id,
            slides: await listPptVoiceSlides(id),
            messages: history,
            question: parsed.data.message,
            signal: request.signal,
            onProgress: async (event) => {
              if (event.applied?.length) {
                await updatePptVoiceSlidesNotes(id, event.applied);
                await refreshPptVoiceReadyStatus(id);
              }
              const now = Date.now();
              const thought = event.thought || '';
              const important = Boolean(event.applied?.length || event.reply);
              if (!important && thought && thought === lastThought) return;
              if (!important && now - lastThoughtAt < 180) return;
              lastThoughtAt = now;
              if (thought) lastThought = thought;
              enqueue({
                type: 'progress',
                thought: thought || undefined,
                reply: event.reply ? publicAssistantReply(event.reply) : undefined,
                applied: event.applied?.length || 0,
                project: event.applied?.length ? await getPptVoiceSnapshot(id) : undefined
              });
            }
          });
          if (result.applied.length) {
            await updatePptVoiceSlidesNotes(id, result.applied);
            await refreshPptVoiceReadyStatus(id);
            await appendPptVoiceEvent({
              projectId: id,
              text: `对话已应用 ${result.applied.length} 页备注`,
              level: 'output'
            });
          }
          const reply = publicAssistantReply(result.reply) || result.reply;
          await appendPptVoiceMessage(id, 'assistant', reply);
          enqueue({
            type: 'done',
            reply,
            applied: result.applied.length,
            thought: result.applied.length ? `已更新 ${result.applied.length} 页备注` : '已完成回复',
            project: await getPptVoiceSnapshot(id)
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : '对话失败。';
          await appendPptVoiceEvent({ projectId: id, text: message, level: 'error' });
          enqueue({ type: 'error', error: message, project: await getPptVoiceSnapshot(id) });
        } finally {
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
      Connection: 'keep-alive'
    }
  });
}
