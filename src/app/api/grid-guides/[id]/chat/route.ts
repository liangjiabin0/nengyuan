import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/request';
import { listGridGuideAttachments } from '@/lib/grid-guide/attachments';
import { startGridGuideTask } from '@/lib/grid-guide/runner';
import {
  addGridGuideMessage,
  assertGridGuideOwner,
  getGridGuideProject,
  setGridGuideStatus
} from '@/lib/grid-guide/store';
import { enqueueJob, isJobQueueEnabled } from '@/lib/jobs/queue';

export const runtime = 'nodejs';
export const maxDuration = 1800;
type Context = { params: Promise<{ id: string }> };

const schema = z.object({
  message: z.string().trim().min(1).max(20_000),
  selection: z.string().trim().max(20_000).optional(),
  initial: z.boolean().optional()
}).strict();

export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertGridGuideOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '项目指南不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该项目指南。' }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '对话内容格式或长度无效。' }, { status: 422 });
  let project = await getGridGuideProject(id);
  if (!project) return NextResponse.json({ error: '项目指南不存在。' }, { status: 404 });
  if (project.status === 'generating') {
    return NextResponse.json({ error: '上一轮设计仍在进行，请稍候。' }, { status: 409 });
  }

  if (!parsed.data.initial) {
    await addGridGuideMessage(id, 'user', parsed.data.message, parsed.data.selection);
  }
  await setGridGuideStatus(id, 'generating', null);
  project = await getGridGuideProject(id)!;
  const taskPayload = {
    projectId: id,
    instruction: parsed.data.message,
    selection: parsed.data.selection
  };
  if (isJobQueueEnabled()) {
    await enqueueJob('grid-guide-task', taskPayload);
  } else {
    void startGridGuideTask(taskPayload).catch((error) => {
      console.error('[grid-guide] background task failed', error);
    });
  }
  const attachments = await listGridGuideAttachments(id);
  return NextResponse.json({ project: { ...project, attachments } }, { status: 202 });
}
