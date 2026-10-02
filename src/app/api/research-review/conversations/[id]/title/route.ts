import { NextResponse } from 'next/server';
import {
  assertConversationOwner,
  generateConversationTitle,
  getChatConversationTitleContext,
  isDefaultConversationTitle,
  updateChatConversationTitle,
  updateChatConversationTitleIfDefault
} from '@/lib/chat-history';
import { RESEARCH_REVIEW_KIND } from '@/lib/research-review/constants';
import { requireUser } from '@/lib/auth/request';
import { notifyChatConversationChanged } from '@/lib/chat-live';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const scope = { userId: auth.user!.id, kind: RESEARCH_REVIEW_KIND };
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
  if (!force && !isDefaultConversationTitle(currentTitle)) {
    return NextResponse.json({ conversation: data.conversation, skipped: true });
  }

  const reportTitle = data.firstAssistantReportTitle || '';
  const titleSeed = reportTitle
    ? `${question}\n报告题目：${reportTitle}`
    : (data.firstAssistantContent || '');
  const title = await generateConversationTitle(question, titleSeed);
  const savedTitle = force
    ? await updateChatConversationTitle(id, title, scope)
    : await updateChatConversationTitleIfDefault(id, title, scope);
  if (!savedTitle) return jsonError('会话不存在。', 404);
  await notifyChatConversationChanged({
    userId: scope.userId,
    conversationId: id,
    kind: RESEARCH_REVIEW_KIND,
    resource: 'metadata'
  });
  return NextResponse.json({
    conversation: {
      ...data.conversation,
      title: savedTitle
    }
  });
}
