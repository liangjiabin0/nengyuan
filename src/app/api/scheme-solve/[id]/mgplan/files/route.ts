import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import {
  mgplanConfigDir,
  previewTimeseries,
  restoreTimeseriesTemplate,
  writeTimeseriesCsv
} from '@/lib/scheme-solve/mgplan-case';
import { assertSchemeOwner, getSchemeIdea } from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '方案不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该方案。' }, { status: 403 });

  const form = await request.formData().catch(() => null);
  const ideaId = String(form?.get('ideaId') || new URL(request.url).searchParams.get('ideaId') || '').trim();
  const key = String(form?.get('key') || new URL(request.url).searchParams.get('key') || '').trim();
  const restore = String(form?.get('restore') || '') === '1';
  if (!ideaId || !key) return NextResponse.json({ error: '缺少 ideaId 或 key。' }, { status: 422 });
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== id) return NextResponse.json({ error: '想法不存在。' }, { status: 404 });

  const configDir = mgplanConfigDir(id, ideaId);
  if (restore) {
    return NextResponse.json({ ok: true, preview: restoreTimeseriesTemplate(configDir, key) });
  }
  const file = form?.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: '请上传 CSV 文件。' }, { status: 422 });
  const text = await file.text();
  const preview = writeTimeseriesCsv(configDir, key, text);
  return NextResponse.json({ ok: true, preview, timeseries: previewTimeseries(configDir) });
}
