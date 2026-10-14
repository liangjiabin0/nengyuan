import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { createTaskFromUpload, PAPER_REVIEW_MAX_FILES } from '@/lib/paper-review/service';
import { listPaperReviewTasks } from '@/lib/paper-review/store';

export const runtime = 'nodejs';

function summary(t: Awaited<ReturnType<typeof listPaperReviewTasks>>[number]) {
  return { id: t.id, title: t.title, status: t.status, stage: t.stage, progress: t.progress, createdAt: t.createdAt, updatedAt: t.updatedAt };
}

/** 当前用户的评审任务列表（只返回自己的）。 */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const page = Number(new URL(request.url).searchParams.get('page')) || 1;
  const tasks = await listPaperReviewTasks(auth.user!.id, { page });
  return NextResponse.json({ tasks: tasks.map(summary) });
}

/** 创建任务：multipart，files[] + roles[]（与文件一一对应）+ options（JSON 字符串）。 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f): f is File => f instanceof File);
    const roles = form.getAll('roles').map(String);
    if (files.length > PAPER_REVIEW_MAX_FILES) return NextResponse.json({ error: `一次最多上传 ${PAPER_REVIEW_MAX_FILES} 个文件` }, { status: 413 });
    let options: unknown = {};
    try {
      options = JSON.parse(String(form.get('options') || '{}'));
    } catch {
      return NextResponse.json({ error: '评审设置不合法' }, { status: 400 });
    }
    const uploads = await Promise.all(files.map(async (f, i) => ({ name: f.name, role: roles[i] || (i === 0 ? 'paper' : 'supplement'), buffer: Buffer.from(await f.arrayBuffer()) })));
    const task = await createTaskFromUpload(auth.user!.id, uploads, options);
    return NextResponse.json({ task: summary(task) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '创建任务失败' }, { status: 400 });
  }
}
