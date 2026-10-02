import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { deleteConversationMessage } from '@/lib/chat-message-actions';
import { getChatConversation } from '@/lib/chat-history';
import { notifyChatConversationChanged } from '@/lib/chat-live';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id, messageId } = await params;
  const result = await deleteConversationMessage(id, auth.user!.id, messageId);
  if (!result.ok) return jsonError(result.error, result.status);
  const conversation = await getChatConversation(id);
  await notifyChatConversationChanged({
    userId: auth.user!.id,
    conversationId: id,
    kind: conversation?.kind === 'research-review' ? 'research-review' : 'chat',
    resource: 'messages'
  });
  return NextResponse.json({ ok: true, messages: result.messages });
}
