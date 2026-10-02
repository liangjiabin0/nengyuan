import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import {
  mgplanConfigDir,
  prepareMgplanWorkspace,
  previewTimeseries,
  readSmallTables,
  writeSmallTables
} from '@/lib/scheme-solve/mgplan-case';
import { getMgplanHealth } from '@/lib/scheme-solve/mgplan';
import { assertSchemeOwner, getSchemeIdea } from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

async function ideaOrError(sessionId: string, ideaId: string) {
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== sessionId) return null;
  return idea;
}

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '方案不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该方案。' }, { status: 403 });
  const ideaId = new URL(request.url).searchParams.get('ideaId')?.trim() || '';
  if (!ideaId) return NextResponse.json({ error: '缺少 ideaId。' }, { status: 422 });
  const idea = await ideaOrError(id, ideaId);
  if (!idea) return NextResponse.json({ error: '想法不存在。' }, { status: 404 });
  const { configDir } = prepareMgplanWorkspace(id, ideaId, { seedFixture: true });
  return NextResponse.json({
    ideaId,
    title: idea.title,
    health: getMgplanHealth(),
    tables: readSmallTables(configDir),
    timeseries: previewTimeseries(configDir)
  });
}

export async function PUT(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '方案不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该方案。' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const ideaId = String(body.ideaId || new URL(request.url).searchParams.get('ideaId') || '').trim();
  if (!ideaId) return NextResponse.json({ error: '缺少 ideaId。' }, { status: 422 });
  const idea = await ideaOrError(id, ideaId);
  if (!idea) return NextResponse.json({ error: '想法不存在。' }, { status: 404 });
  const tables = Array.isArray(body.tables) ? body.tables : [];
  const configDir = mgplanConfigDir(id, ideaId);
  writeSmallTables(configDir, tables);
  return NextResponse.json({
    ok: true,
    tables: readSmallTables(configDir),
    timeseries: previewTimeseries(configDir)
  });
}
