import { NextResponse } from 'next/server';
import { assertConversationOwner } from '@/lib/chat-history';
import { requireUser } from '@/lib/auth/request';
import { stopConversationGeneration } from '@/lib/chat-generation-stop';
import { RESEARCH_REVIEW_KIND } from '@/lib/research-review/constants';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const ownership = await assertConversationOwner(id, auth.user!.id);
  if (!ownership.conversation) return jsonError('会话不存在。', 404);
  if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
  if (!(['chat', RESEARCH_REVIEW_KIND] as string[]).includes(ownership.conversation.kind)) {
    return jsonError('会话不存在。', 404);
  }
  await stopConversationGeneration(id, auth.user!.id);
  return NextResponse.json({ ok: true });
}
