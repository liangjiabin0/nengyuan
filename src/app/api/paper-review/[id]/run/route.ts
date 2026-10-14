import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAdminUser } from '@/lib/auth';
import { requireUser } from '@/lib/auth/request';
import { cancelTask, exportDraftPackage, runTask } from '@/lib/paper-review/service';
import { assertPaperReviewOwner, updatePaperReviewTask } from '@/lib/paper-review/store';
import { optionsSchema, PAPER_REVIEW_STAGES } from '@/lib/paper-review/types';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  action: z.enum(['start', 'retry', 'rerun_from', 'cancel', 'export_draft', 'update_options']),
  fromStage: z.enum(PAPER_REVIEW_STAGES).optional(),
  force: z.boolean().optional(),
  options: z.unknown().optional()
});

/** 执行控制：开始 / 重试（从失败处恢复）/ 从某阶段重跑 / 取消 / 导出草稿包 / 修改设置。 */
export async function POST(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const own = await assertPaperReviewOwner(id, auth.user!.id, isAdminUser(auth.user));
  if (!own.exists) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  if (!own.allowed) return NextResponse.json({ error: '无权操作该任务' }, { status: 403 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: '参数不合法' }, { status: 400 });
  const body = parsed.data;
  const task = own.task!;
  try {
    if (body.action === 'cancel') {
      await cancelTask(id);
      return NextResponse.json({ ok: true });
    }
    if (['queued', 'running'].includes(task.status)) return NextResponse.json({ error: '任务正在运行' }, { status: 409 });
    if (body.action === 'update_options') {
      const options = optionsSchema.safeParse({ ...task.options, ...(body.options as object || {}) });
      if (!options.success) return NextResponse.json({ error: '评审设置不合法' }, { status: 400 });
      await updatePaperReviewTask(id, { options: options.data });
      return NextResponse.json({ ok: true, options: options.data });
    }
    if (body.action === 'export_draft') {
      const r = await exportDraftPackage(id);
      return NextResponse.json({ ok: true, complete: r.complete });
    }
    if (body.action === 'start' || body.action === 'retry') {
      // 重试：已通过且检查点有效的阶段会被跳过，只从失败/受阻处继续
      return NextResponse.json(await runTask(id, { force: body.force === true }));
    }
    if (!body.fromStage) return NextResponse.json({ error: '缺少阶段' }, { status: 400 });
    return NextResponse.json(await runTask(id, { fromStage: body.fromStage }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '操作失败' }, { status: 400 });
  }
}
