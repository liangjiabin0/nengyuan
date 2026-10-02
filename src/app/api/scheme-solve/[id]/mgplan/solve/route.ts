import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { enqueueMgplanSolve } from '@/lib/scheme-solve/mgplan-runner';
import { assertSchemeOwner, getSchemeIdea, getSchemeSnapshot } from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';
export const maxDuration = 900;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '方案不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该方案。' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const ideaId = String(body.ideaId || '').trim();
  if (!ideaId) return NextResponse.json({ error: '缺少 ideaId。' }, { status: 422 });
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== id) return NextResponse.json({ error: '想法不存在。' }, { status: 404 });
  if (idea.problemClass !== 'mgplan') {
    return NextResponse.json({ error: '该想法不是规划计算类型。' }, { status: 422 });
  }
  const queued = await enqueueMgplanSolve(id, ideaId, body.allowFixture === true);
  return NextResponse.json({
    ok: true,
    mode: queued.mode,
    job: queued.mode === 'queued' ? queued.job : undefined,
    result: queued.mode === 'inline' ? queued.result : undefined,
    session: await getSchemeSnapshot(id)
  }, { status: 202 });
}
