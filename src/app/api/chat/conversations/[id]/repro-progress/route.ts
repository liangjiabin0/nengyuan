import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { assertConversationOwner } from '@/lib/chat-history';
import { listChatReproProgress } from '@/lib/opencode/chat-repro-progress';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const ownership = await assertConversationOwner(id, auth.user!.id, 'chat');
  if (!ownership.conversation) return jsonError('会话不存在。', 404);
  if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
  const items = listChatReproProgress(id);
  const currentOwnership = await assertConversationOwner(id, auth.user!.id, 'chat');
  if (!currentOwnership.conversation || !currentOwnership.allowed) {
    return jsonError('会话状态已发生变化，请刷新后重试。', 409);
  }
  return NextResponse.json({ items });
}
