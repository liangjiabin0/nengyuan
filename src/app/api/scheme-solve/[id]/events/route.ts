import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { assertSchemeOwner, listSchemeEvents } from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '方案不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该方案。' }, { status: 403 });
  const after = Number(new URL(request.url).searchParams.get('after') || 0);
  return NextResponse.json({
    events: await listSchemeEvents(id, Number.isFinite(after) ? after : 0)
  });
}
