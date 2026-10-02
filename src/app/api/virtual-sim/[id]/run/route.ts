import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { assertSchemeOwner, getSchemeSession, listSolvableIdeaIds } from '@/lib/scheme-solve/store';
import { startVirtualSimResearch } from '@/lib/virtual-sim/pipeline';

export const runtime = 'nodejs';
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '仿真任务不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该任务。' }, { status: 403 });
  const session = await getSchemeSession(id);
  if (session?.source && session.source !== 'virtual-sim') {
    return NextResponse.json({ error: '仿真任务不存在。' }, { status: 404 });
  }
  if (session?.status === 'researching') {
    return NextResponse.json({ error: '仿真已在进行中。' }, { status: 409 });
  }
  const ideaIds = await listSolvableIdeaIds(id);
  if (!ideaIds.length) {
    return NextResponse.json({ error: '没有可运行的仿真任务。' }, { status: 422 });
  }
  const snapshot = await startVirtualSimResearch(id, ideaIds);
  return NextResponse.json({ ok: true, session: snapshot }, { status: 202 });
}
