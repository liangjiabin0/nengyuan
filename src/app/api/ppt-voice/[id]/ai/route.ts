import { z } from 'zod';
import { requireUser } from '@/lib/auth/request';
import { generatePptVoiceNotes } from '@/lib/ppt-voice/notes-ai';
import {
  appendPptVoiceEvent,
  assertPptVoiceOwner,
  getPptVoiceSnapshot,
  listPptVoiceSlides,
  refreshPptVoiceReadyStatus,
  updatePptVoiceSlidesNotes
} from '@/lib/ppt-voice/store';

export const runtime = 'nodejs';
export const maxDuration = 600;
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const schema = z.object({
  action: z.enum(['generate', 'polish']).default('generate'),
  scope: z.enum(['empty', 'all', 'one']).default('empty'),
  slideIndex: z.number().int().positive().optional(),
  instruction: z.string().trim().max(500).optional()
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

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: 'AI 请求无效。' }, { status: 422 });

  const slides = await listPptVoiceSlides(id);
  const selected = parsed.data.scope === 'one'
    ? slides.filter((slide) => slide.slideIndex === parsed.data.slideIndex)
    : parsed.data.scope === 'empty'
      ? slides.filter((slide) => !slide.notes.trim())
      : slides;
  if (!selected.length) {
    return Response.json({ error: parsed.data.scope === 'empty' ? '没有空备注页。' : '没有可处理的页面。' }, { status: 422 });
  }

  const instruction = [
    parsed.data.action === 'polish' ? '在现有备注基础上润色为更适合口头汇报的讲稿，不要改变技术含义。' : '根据幻灯片内容撰写演讲者备注。',
    parsed.data.instruction || ''
  ].filter(Boolean).join(' ');

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
        thought: parsed.data.action === 'polish'
          ? `开始润色 ${selected.length} 页备注`
          : `开始为 ${selected.length} 页写备注`,
        project: await getPptVoiceSnapshot(id)
      });

      void (async () => {
        try {
          await appendPptVoiceEvent({
            projectId: id,
            text: parsed.data.action === 'polish'
              ? `AI 正在润色 ${selected.length} 页备注`
              : `AI 正在为 ${selected.length} 页撰写备注`
          });
          let lastThoughtAt = 0;
          const updates = await generatePptVoiceNotes(selected, {
            projectId: id,
            instruction,
            signal: request.signal,
            onThought: (text) => {
              const now = Date.now();
              if (now - lastThoughtAt < 180) return;
              lastThoughtAt = now;
              enqueue({ type: 'progress', thought: text });
            },
            onProgress: (info) => {
              enqueue({
                type: 'progress',
                thought: info.message,
                reply: `${Math.min(info.current, info.total)}/${info.total} 页`
              });
            },
            onBatch: async (batch) => {
              await updatePptVoiceSlidesNotes(id, batch);
              await refreshPptVoiceReadyStatus(id);
              enqueue({
                type: 'progress',
                applied: batch.length,
                thought: `已写入第 ${batch.map((item) => item.slideIndex).join('、')} 页`,
                project: await getPptVoiceSnapshot(id)
              });
            }
          });
          if (!updates.length) throw new Error('模型没有返回可用备注。');
          await updatePptVoiceSlidesNotes(id, updates);
          await refreshPptVoiceReadyStatus(id);
          await appendPptVoiceEvent({ projectId: id, text: `AI 已更新 ${updates.length} 页备注`, level: 'output' });
          enqueue({
            type: 'done',
            updated: updates.length,
            thought: `已完成 ${updates.length} 页`,
            project: await getPptVoiceSnapshot(id)
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'AI 写备注失败。';
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
