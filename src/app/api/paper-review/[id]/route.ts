import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { isAdminUser } from '@/lib/auth';
import { requireUser } from '@/lib/auth/request';
import { isPaperReviewRunning } from '@/lib/paper-review/runner';
import { assertPaperReviewOwner, deletePaperReviewTask, listPaperReviewEvents, totalTokens } from '@/lib/paper-review/store';
import { PAPER_REVIEW_STAGES, STAGE_GROUPS, STAGE_LABELS } from '@/lib/paper-review/types';
import { taskDir } from '@/lib/paper-review/workspace';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

/** 任务详情 + 增量事件（?after=上次最后一个事件 id）。 */
export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const own = await assertPaperReviewOwner(id, auth.user!.id, isAdminUser(auth.user));
  if (!own.exists) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  if (!own.allowed) return NextResponse.json({ error: '无权访问该任务' }, { status: 403 });
  const task = own.task!;
  const after = Number(new URL(request.url).searchParams.get('after')) || 0;
  const events = await listPaperReviewEvents(id, after);
  const usage = task.usage.reduce((acc, u) => ({ calls: acc.calls + 1, promptTokens: acc.promptTokens + u.promptTokens, completionTokens: acc.completionTokens + u.completionTokens, reasoningTokens: acc.reasoningTokens + u.reasoningTokens, durationMs: acc.durationMs + u.durationMs }), { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, durationMs: 0 });
  const models = [...new Set(task.usage.map((u) => `${u.requestedModel}→${u.actualModel || '?'}（${u.thinking}）`))];
  return NextResponse.json({
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      stage: task.stage,
      progress: task.progress,
      progressDetail: task.progressDetail,
      options: task.options,
      inputs: task.inputs.map((input) => ({ id: input.id, role: input.role, name: input.name, size: input.size, sha256: input.sha256 })),
      skills: task.skills ? Object.fromEntries(Object.entries(task.skills).map(([k, v]) => {
        const s = v as { version?: string | null; contentSha256?: string; originalName?: string };
        return [k, { version: s.version, originalName: s.originalName, contentSha256: s.contentSha256?.slice(0, 16) }];
      })) : null,
      model: task.model,
      stages: PAPER_REVIEW_STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s], group: STAGE_GROUPS[s], ...(task.stages[s] || { status: 'pending' }) })),
      gates: task.gates,
      artifacts: task.artifacts,
      usage: { ...usage, totalTokens: totalTokens(task), limit: task.options.maxModelTokens, models },
      error: task.error,
      running: isPaperReviewRunning(task.id) || ['queued', 'running'].includes(task.status),
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt
    },
    events
  });
}

/** 删除任务及其文件（运行中不允许删除）。 */
export async function DELETE(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const own = await assertPaperReviewOwner(id, auth.user!.id, false);
  if (!own.exists) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  if (!own.allowed) return NextResponse.json({ error: '无权删除该任务' }, { status: 403 });
  if (['queued', 'running'].includes(own.task!.status) || isPaperReviewRunning(id)) return NextResponse.json({ error: '任务正在运行，请先取消' }, { status: 409 });
  await deletePaperReviewTask(id);
  fs.rmSync(taskDir(id), { recursive: true, force: true });
  return NextResponse.json({ ok: true });
}
