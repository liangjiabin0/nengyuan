import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/request';
import { DEFAULT_PPT_VOICE } from '@/lib/ppt-voice/constants';
import { resumePptVoiceBuild } from '@/lib/ppt-voice/orchestrator';
import {
  assertPptVoiceOwner,
  deletePptVoiceProject,
  getPptVoiceProject,
  getPptVoiceSnapshot,
  updatePptVoiceTitle,
  updatePptVoiceVoice
} from '@/lib/ppt-voice/store';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const voiceSchema = z.object({
  model: z.string().trim().min(1).max(80).optional(),
  voiceId: z.string().trim().min(1).max(80).optional(),
  profileName: z.string().trim().max(80).optional(),
  instruction: z.string().max(500).optional(),
  rate: z.number().min(0.5).max(2).optional(),
  pitch: z.number().min(0.5).max(2).optional(),
  volume: z.number().int().min(0).max(100).optional(),
  seed: z.number().int().min(0).max(65535).optional(),
  emptyNotePolicy: z.enum(['error', 'skip']).optional(),
  transitionBufferSeconds: z.number().min(0).max(10).optional(),
  lastSlideHoldSeconds: z.number().min(0).max(30).optional(),
  minimumSlideSeconds: z.number().min(0.5).max(30).optional()
});

const patchSchema = voiceSchema.extend({
  title: z.string().trim().min(1).max(200).optional()
});

async function ownerError(id: string, userId: string) {
  const ownership = await assertPptVoiceOwner(id, userId);
  if (!ownership.exists) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该项目。' }, { status: 403 });
  return null;
}

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  resumePptVoiceBuild(id);
  const after = Number(new URL(request.url).searchParams.get('after') || 0);
  const project = await getPptVoiceSnapshot(id, Number.isFinite(after) ? after : 0);
  if (!project) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
  return NextResponse.json({ project });
}

export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const project = await getPptVoiceProject(id);
  if (!project) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '参数无效。' }, { status: 422 });
  const { title, ...voicePatch } = parsed.data;
  if (title) await updatePptVoiceTitle(id, title);
  const hasVoice = Object.values(voicePatch).some((value) => value !== undefined);
  if (hasVoice) await updatePptVoiceVoice(id, { ...DEFAULT_PPT_VOICE, ...project.voice, ...voicePatch });
  if (!title && !hasVoice) return NextResponse.json({ error: '没有可更新的字段。' }, { status: 422 });
  return NextResponse.json({ project: await getPptVoiceSnapshot(id) });
}

export async function DELETE(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const project = await getPptVoiceProject(id);
  if (project?.status === 'generating' || project?.status === 'checking') {
    return NextResponse.json({ error: '任务进行中，暂时不能删除。' }, { status: 409 });
  }
  await deletePptVoiceProject(id);
  return NextResponse.json({ ok: true });
}
