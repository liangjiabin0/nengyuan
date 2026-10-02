import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { assertSchemeOwner, getSchemeIdea } from '@/lib/scheme-solve/store';
import { listIdeaReportFiles } from '@/lib/scheme-solve/workspace';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const KINDS = ['design', 'model', 'result', 'results', 'reviewSmall', 'reviewLarge', 'report'] as const;

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '方案不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该方案。' }, { status: 403 });

  const ideaId = new URL(request.url).searchParams.get('ideaId')?.trim() || '';
  if (!ideaId) return NextResponse.json({ error: '缺少 ideaId。' }, { status: 422 });
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== id) return NextResponse.json({ error: '想法不存在。' }, { status: 404 });

  const files = listIdeaReportFiles(id, ideaId);
  const kind = new URL(request.url).searchParams.get('kind')?.trim() as (typeof KINDS)[number] | '';
  if (kind && KINDS.includes(kind)) {
    return NextResponse.json({ ideaId, kind, content: files[kind] || '' });
  }
  return NextResponse.json({
    ideaId,
    title: idea.title,
    summary: idea.summary,
    decisions: idea.decisions,
    limits: idea.limits,
    goal: idea.goal,
    files
  });
}
