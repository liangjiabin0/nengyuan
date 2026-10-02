import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { assertSchemeOwner, getSchemeIdea, getSchemeSession } from '@/lib/scheme-solve/store';
import { buildVirtualSimViz } from '@/lib/virtual-sim/visualize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
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
  const ideaId = new URL(request.url).searchParams.get('ideaId')?.trim()
    || '';
  if (!ideaId) return NextResponse.json({ error: '缺少 ideaId。' }, { status: 422 });
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== id) return NextResponse.json({ error: '任务不存在。' }, { status: 404 });
  return NextResponse.json(
    {
      ideaId,
      viz: await buildVirtualSimViz(id, ideaId, idea.problemClass || session?.toolId)
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
