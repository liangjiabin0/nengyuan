import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { enqueueSchemeResearch } from '@/lib/scheme-solve/orchestrator';
import { assertSchemeOwner, getSchemeSnapshot, listSolvableIdeaIds } from '@/lib/scheme-solve/store';

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
  const requested = Array.isArray(body?.ideaIds)
    ? body.ideaIds.map((value: unknown) => String(value || '').trim()).filter(Boolean)
    : [];
  const solvable = new Set(await listSolvableIdeaIds(id));
  const ideaIds = (requested.length ? requested : [...solvable]).filter((ideaId: string) => solvable.has(ideaId));
  if (!ideaIds.length) {
    return NextResponse.json({ error: '没有可研究的想法。请先完成头脑风暴。' }, { status: 422 });
  }

  enqueueSchemeResearch(id, ideaIds).catch(() => undefined);
  const snapshot = await getSchemeSnapshot(id);
  return NextResponse.json({ ok: true, session: snapshot }, { status: 202 });
}
