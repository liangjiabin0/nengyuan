import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import {
  deleteCorpusComment,
  getCorpusCommentById,
  listCorpusComments,
  updateCorpusComment
} from '@/lib/corpus/comments';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;

  try {
    const { id } = await params;
    const payload = (await request.json()) as { body?: string; authorName?: string };
    const comment = await updateCorpusComment({
      id,
      body: payload.body,
      authorName: payload.authorName,
      user: auth.user!
    });
    if (!comment) return jsonError('备注不存在。', 404);
    const comments = await listCorpusComments({
      relativePath: comment.relativePath,
      recordKey: comment.recordKey || undefined
    });
    return NextResponse.json({ comment, comments });
  } catch (error) {
    const status = Number((error as { status?: number })?.status || 400);
    return jsonError(error instanceof Error ? error.message : '修改备注失败。', status);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;

  try {
    const { id } = await params;
    const existing = await getCorpusCommentById(id);
    const ok = await deleteCorpusComment(id, auth.user!);
    if (!ok) return jsonError('备注不存在。', 404);
    const comments = existing
      ? await listCorpusComments({
          relativePath: existing.relativePath,
          recordKey: existing.recordKey || undefined
        })
      : [];
    return NextResponse.json({ ok: true, comments });
  } catch (error) {
    const status = Number((error as { status?: number })?.status || 400);
    return jsonError(error instanceof Error ? error.message : '删除备注失败。', status);
  }
}
