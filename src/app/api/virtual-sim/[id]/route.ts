import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { listSchemeSolveAttachments } from '@/lib/scheme-solve/attachments';
import { resumeSchemeResearch } from '@/lib/scheme-solve/orchestrator';
import {
  assertSchemeOwner,
  deleteSchemeSession,
  getSchemeSession,
  getSchemeSnapshot
} from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

async function ownerError(id: string, userId: string) {
  const ownership = await assertSchemeOwner(id, userId);
  if (!ownership.exists) return NextResponse.json({ error: '仿真任务不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该任务。' }, { status: 403 });
  return null;
}

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const session = await getSchemeSession(id);
  if (session?.source && session.source !== 'virtual-sim') {
    return NextResponse.json({ error: '仿真任务不存在。' }, { status: 404 });
  }
  resumeSchemeResearch(id);
  const after = Number(new URL(request.url).searchParams.get('after') || 0);
  const snapshot = await getSchemeSnapshot(id, Number.isFinite(after) ? after : 0);
  if (!snapshot) return NextResponse.json({ error: '仿真任务不存在。' }, { status: 404 });
  const attachments = await listSchemeSolveAttachments(id);
  return NextResponse.json({ session: { ...snapshot, attachments } });
}

export async function DELETE(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const session = await getSchemeSession(id);
  if (session?.source && session.source !== 'virtual-sim') {
    return NextResponse.json({ error: '仿真任务不存在。' }, { status: 404 });
  }
  if (session?.status === 'brainstorming' || session?.status === 'researching') {
    return NextResponse.json({ error: '任务进行中，暂时不能删除。' }, { status: 409 });
  }
  await deleteSchemeSession(id);
  return NextResponse.json({ ok: true });
}
