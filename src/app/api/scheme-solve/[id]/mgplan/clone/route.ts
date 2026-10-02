import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { cloneSchemeIdea, assertSchemeOwner, getSchemeIdea, getSchemeSnapshot } from '@/lib/scheme-solve/store';
import { schemeIdeaDirectory } from '@/lib/scheme-solve/workspace';

export const runtime = 'nodejs';

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
  const cloned = await cloneSchemeIdea(ideaId);
  const src = schemeIdeaDirectory(id, ideaId);
  const dest = schemeIdeaDirectory(id, cloned.id);
  if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
  return NextResponse.json({ ok: true, idea: cloned, session: await getSchemeSnapshot(id) });
}
