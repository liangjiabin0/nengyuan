import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAdminUser } from '@/lib/auth';
import { requireUser } from '@/lib/auth/request';
import { approveProposal, generateProposals, getProposal, listProposals, rejectProposal, rollbackProposal } from '@/lib/paper-review/proposals';
import { assertPaperReviewOwner } from '@/lib/paper-review/store';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

async function guard(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return { error: auth.error };
  const { id } = await context.params;
  const isAdmin = isAdminUser(auth.user);
  const own = await assertPaperReviewOwner(id, auth.user!.id, isAdmin);
  if (!own.exists) return { error: NextResponse.json({ error: '任务不存在' }, { status: 404 }) };
  if (!own.allowed) return { error: NextResponse.json({ error: '无权访问该任务' }, { status: 403 }) };
  return { id, user: { id: auth.user!.id, username: auth.user!.username, isAdmin } };
}

/** 列出本任务的经验 / Skill 更新候选（只读）。 */
export async function GET(request: Request, context: Context) {
  const g = await guard(request, context);
  if ('error' in g) return g.error;
  return NextResponse.json({ proposals: await listProposals(g.id), isAdmin: g.user.isAdmin });
}

const actionSchema = z.object({
  action: z.enum(['generate', 'approve', 'reject', 'rollback']),
  proposalId: z.string().uuid().optional(),
  /** 确认时必须回传页面上看到的候选 hash，防止“看到的”和“写入的”不一致 */
  proposalHash: z.string().regex(/^[0-9a-f]{64}$/).optional()
});

/** 生成候选（不写入）/ 确认写入 / 拒绝 / 回滚。共享技能的写入与回滚只允许管理员。 */
export async function POST(request: Request, context: Context) {
  const g = await guard(request, context);
  if ('error' in g) return g.error;
  const parsed = actionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: '参数不合法' }, { status: 400 });
  const { action, proposalId, proposalHash } = parsed.data;
  try {
    if (action === 'generate') return NextResponse.json({ proposals: await generateProposals(g.id) });
    if (!proposalId) return NextResponse.json({ error: '缺少候选 ID' }, { status: 400 });
    const proposal = await getProposal(proposalId);
    if (!proposal || proposal.taskId !== g.id) return NextResponse.json({ error: '候选不存在' }, { status: 404 });
    if (action === 'approve') {
      if (!proposalHash) return NextResponse.json({ error: '缺少确认凭证' }, { status: 400 });
      return NextResponse.json(await approveProposal(proposalId, g.user, proposalHash));
    }
    if (action === 'reject') {
      await rejectProposal(proposalId, g.user);
      return NextResponse.json({ ok: true });
    }
    await rollbackProposal(proposalId, g.user);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '操作失败' }, { status: 400 });
  }
}
