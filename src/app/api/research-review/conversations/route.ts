import { NextResponse } from 'next/server';
import {
  createChatConversation,
  DEFAULT_CONVERSATION_TITLE,
  listChatHistory
} from '@/lib/chat-history';
import { RESEARCH_REVIEW_KIND } from '@/lib/research-review/constants';
import { requireUser } from '@/lib/auth/request';
import { notifyChatConversationChanged } from '@/lib/chat-live';
import { listActiveConversationRunIds } from '@/lib/chat-run-registry';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const conversations = await listChatHistory(auth.user!.id, RESEARCH_REVIEW_KIND);
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
  const conversation = await createChatConversation(
    id,
    DEFAULT_CONVERSATION_TITLE,
    auth.user!.id,
    undefined,
    RESEARCH_REVIEW_KIND
  );
  await notifyChatConversationChanged({
    userId: auth.user!.id,
    conversationId: id,
    kind: RESEARCH_REVIEW_KIND
  });
  return NextResponse.json({ conversation });
}
