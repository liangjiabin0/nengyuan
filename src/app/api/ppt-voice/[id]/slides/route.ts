import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/request';
import {
  assertPptVoiceOwner,
  getPptVoiceSnapshot,
  refreshPptVoiceReadyStatus,
  updatePptVoiceSlideNotes,
  updatePptVoiceSlidesNotes
} from '@/lib/ppt-voice/store';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const oneSchema = z.object({
  slideIndex: z.number().int().positive(),
  notes: z.string().max(8000)
});

const manySchema = z.object({
  slides: z.array(oneSchema).min(1).max(80)
});

export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertPptVoiceOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该项目。' }, { status: 403 });

  const body = await request.json().catch(() => null);
  const many = manySchema.safeParse(body);
  const one = oneSchema.safeParse(body);
  if (many.success) {
    await updatePptVoiceSlidesNotes(id, many.data.slides);
  } else if (one.success) {
    await updatePptVoiceSlideNotes(id, one.data.slideIndex, one.data.notes);
  } else {
    return NextResponse.json({ error: '备注内容无效。' }, { status: 422 });
  }
  await refreshPptVoiceReadyStatus(id);
  return NextResponse.json({ project: await getPptVoiceSnapshot(id) });
}
