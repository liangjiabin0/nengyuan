import { NextResponse } from 'next/server';
import {
  createChatConversation,
  DEFAULT_CONVERSATION_TITLE,
  listChatHistory
} from '@/lib/chat-history';
import { requireUser } from '@/lib/auth/request';
import { notifyChatConversationChanged } from '@/lib/chat-live';
import { listActiveConversationRunIds } from '@/lib/chat-run-registry';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const conversations = await listChatHistory(auth.user!.id);
  const active = new Set(await listActiveConversationRunIds());
  return NextResponse.json({
    conversations: conversations.map((conversation) => ({
      ...conversation,
      generating: active.has(conversation.id)
    }))
  });
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const id = crypto.randomUUID();
  const conversation = await createChatConversation(id, DEFAULT_CONVERSATION_TITLE, auth.user!.id);
  await notifyChatConversationChanged({
    userId: auth.user!.id,
    conversationId: id,
    kind: 'chat'
  });
  return NextResponse.json({ conversation });
}
