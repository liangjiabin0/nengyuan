import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { runPptVoicePreview } from '@/lib/ppt-voice/orchestrator';
import { assertPptVoiceOwner, getPptVoiceSnapshot } from '@/lib/ppt-voice/store';

export const runtime = 'nodejs';
export const maxDuration = 180;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertPptVoiceOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该项目。' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const slideIndex = Number(body?.slideIndex || 0);
  if (!Number.isInteger(slideIndex) || slideIndex < 1) {
    return NextResponse.json({ error: '请指定要试听的页码。' }, { status: 422 });
  }
  try {
    const preview = await runPptVoicePreview(id, slideIndex);
    return NextResponse.json({ preview, project: await getPptVoiceSnapshot(id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '试听失败。' }, { status: 500 });
  }
}
