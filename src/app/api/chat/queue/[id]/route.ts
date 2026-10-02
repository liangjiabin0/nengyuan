import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { deleteUserSendTurn } from '@/lib/chat-send-queue-store';
import { publishChatLive } from '@/lib/chat-live';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const item = await deleteUserSendTurn(auth.user!.id, id);
  if (!item) return jsonError('排队消息不存在。', 404);
  await publishChatLive(auth.user!.id, {
    type: 'list',
    conversationId: item.conversationId,
    event: { resource: 'send-queue' }
  });
  return NextResponse.json({ item });
}
