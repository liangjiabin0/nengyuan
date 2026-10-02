import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { enqueuePptVoiceBuild, isPptVoiceBuildActive, resumePptVoiceBuild } from '@/lib/ppt-voice/orchestrator';
import { assertPptVoiceOwner, getPptVoiceProject, getPptVoiceSnapshot } from '@/lib/ppt-voice/store';

export const runtime = 'nodejs';
export const maxDuration = 900;

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertPptVoiceOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该项目。' }, { status: 403 });
  const project = await getPptVoiceProject(id);
  if (!project) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const skipEmpty = body?.skipEmpty === true || project.voice.emptyNotePolicy === 'skip';

  if (project.status === 'generating' || isPptVoiceBuildActive(id)) {
    resumePptVoiceBuild(id);
    return NextResponse.json({ ok: true, project: await getPptVoiceSnapshot(id) }, { status: 202 });
  }

  enqueuePptVoiceBuild(id, skipEmpty).catch(() => undefined);
  return NextResponse.json({ ok: true, project: await getPptVoiceSnapshot(id) }, { status: 202 });
}
