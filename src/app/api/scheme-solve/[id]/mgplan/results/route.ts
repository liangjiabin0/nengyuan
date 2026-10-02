import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { getMgplanHealth } from '@/lib/scheme-solve/mgplan';
import { buildMgplanResults } from '@/lib/scheme-solve/mgplan-results';
import { assertSchemeOwner, getSchemeIdea } from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '方案不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该方案。' }, { status: 403 });
  const url = new URL(request.url);
  const ideaId = url.searchParams.get('ideaId')?.trim() || '';
  if (!ideaId) return NextResponse.json({ error: '缺少 ideaId。' }, { status: 422 });
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== id) return NextResponse.json({ error: '想法不存在。' }, { status: 404 });
  const aggregate = url.searchParams.get('aggregate') === 'week' ? 'week' : 'day';
  const payload = await buildMgplanResults(id, ideaId, aggregate);
  return NextResponse.json({
    ...payload,
    health: getMgplanHealth()
  });
}
