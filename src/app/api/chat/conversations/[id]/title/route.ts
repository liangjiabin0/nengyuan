import { NextResponse } from 'next/server';
import {
  assertConversationOwner,
  generateConversationTitle,
  getChatConversationTitleContext,
  isDefaultConversationTitle,
  updateChatConversationTitle,
  updateChatConversationTitleIfDefault
} from '@/lib/chat-history';
import { requireUser } from '@/lib/auth/request';
import { notifyChatConversationChanged } from '@/lib/chat-live';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** 用户发出首条消息后即可命名，不必等助手回复。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const scope = { userId: auth.user!.id, kind: 'chat' as const };
  const ownership = await assertConversationOwner(id, scope.userId, scope.kind);
  if (!ownership.conversation) return jsonError('会话不存在。', 404);
  if (!ownership.allowed) return jsonError('无权访问该会话。', 403);

  const data = await getChatConversationTitleContext(id, scope);
  if (!data) return jsonError('会话不存在。', 404);

  const body = await request.json().catch(() => null) as { force?: boolean; question?: string } | null;
  const question = String(data.firstUserContent || body?.question || '').trim();
  if (!question) {
    return jsonError('需要至少一条用户消息后再命名。', 409);
  }

  const force = Boolean(body?.force);
  const currentTitle = String(data.conversation.title || '').trim();
  // Only name once: skip whenever the conversation already has a non-default title.
  if (!force && !isDefaultConversationTitle(currentTitle)) {
    return NextResponse.json({ conversation: data.conversation, skipped: true });
  }

  const title = await generateConversationTitle(question);
  const savedTitle = force
    ? await updateChatConversationTitle(id, title, scope)
    : await updateChatConversationTitleIfDefault(id, title, scope);
  if (!savedTitle) return jsonError('会话不存在。', 404);
  await notifyChatConversationChanged({
    userId: scope.userId,
    conversationId: id,
    kind: 'chat',
    resource: 'metadata'
  });
  return NextResponse.json({
    conversation: {
      ...data.conversation,
      title: savedTitle
    }
  });
}
