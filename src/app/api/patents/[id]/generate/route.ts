import { NextResponse } from 'next/server';
import {
  createPatentRun,
  getLatestPatentRun,
  listPatentRunEvents,
  recoverStalePatentRuns,
  requestPatentRunCancel
} from '@/lib/patent-generation/run-store';
import { cancelPatentRun, startPatentRun } from '@/lib/patent-generation/runner';
import {
  assertPatentProjectOwner,
  getPatentProject,
  toPatentClientProject
} from '@/lib/patent-generation/store';
import { requireUser } from '@/lib/auth/request';
import { enqueueJob, isJobQueueEnabled } from '@/lib/jobs/queue';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

async function ownerError(id: string, userId: string) {
  const ownership = await assertPatentProjectOwner(id, userId);
  if (!ownership.project) return NextResponse.json({ error: '专利项目不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该专利项目。' }, { status: 403 });
  return null;
}

async function kickPatentRun(runId: string, projectId: string) {
  if (isJobQueueEnabled()) {
    await enqueueJob('patent-run', { runId, projectId });
  } else {
    void startPatentRun(runId, projectId).catch((error) => {
      console.error('[patent] background run failed', error);
    });
  }
}

export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const run = await createPatentRun(id);
  await kickPatentRun(run.id, id);
  return NextResponse.json(
    { run, project: toPatentClientProject(await getPatentProject(id)) },
    { status: run.status === 'queued' ? 202 : 200 }
  );
}

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  await recoverStalePatentRuns();
  const run = await getLatestPatentRun(id);
  const after = Number(new URL(request.url).searchParams.get('after') || 0);
  if (run?.status === 'queued') await kickPatentRun(run.id, id);
  return NextResponse.json({
    run,
    events: run ? await listPatentRunEvents(run.id, Number.isFinite(after) ? after : 0) : [],
    project: toPatentClientProject(await getPatentProject(id))
  });
}

export async function DELETE(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const run = await requestPatentRunCancel(id);
  if (!run) return NextResponse.json({ error: '当前没有可取消的生成任务。' }, { status: 409 });
  await cancelPatentRun(run.id);
  return NextResponse.json({ run });
}
