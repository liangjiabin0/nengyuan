import { NextResponse } from 'next/server';
import {
  assertConversationOwner,
  deleteChatConversation,
  getChatConversationWithMessages,
  patchChatConversation
} from '@/lib/chat-history';
import { RESEARCH_REVIEW_API_BASE, RESEARCH_REVIEW_KIND } from '@/lib/research-review/constants';
import { remapAttachmentPreviewBase } from '@/lib/chat-attachments';
import { requireUser } from '@/lib/auth/request';
import { notifyChatConversationChanged } from '@/lib/chat-live';
import { beginConversationMutation, finishConversationRun, isConversationRunActive } from '@/lib/chat-run-registry';
import { stopConversationGenerationAndSettle } from '@/lib/chat-generation-stop';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const ownership = await assertConversationOwner(id, auth.user!.id, RESEARCH_REVIEW_KIND);
  if (!ownership.conversation) return jsonError('会话不存在。', 404);
  if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
  const data = await getChatConversationWithMessages(id);
  if (!data) return jsonError('会话不存在。', 404);
  const loadedOwnership = await assertConversationOwner(id, auth.user!.id, RESEARCH_REVIEW_KIND);
  if (
    !loadedOwnership.conversation
    || !loadedOwnership.allowed
    || data.conversation.user_id !== auth.user!.id
    || data.conversation.kind !== RESEARCH_REVIEW_KIND
  ) {
    return jsonError('会话状态已发生变化，请刷新后重试。', 409);
  }
  const generating = await isConversationRunActive(id, auth.user!.id);
  return NextResponse.json({
    ...data,
    generating,
    messages: data.messages.map((message) => ({
      ...message,
      inProgress: generating ? message.inProgress : false,
      attachments: message.attachments?.map((attachment) =>
        remapAttachmentPreviewBase(attachment, RESEARCH_REVIEW_API_BASE)
      )
    }))
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const ownership = await assertConversationOwner(id, auth.user!.id, RESEARCH_REVIEW_KIND);
  if (!ownership.conversation) return jsonError('会话不存在。', 404);
  if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
  const body = await request.json().catch(() => null);
  if (!body || !('thunder' in body)) {
    return jsonError('缺少更新字段。');
  }
  const mutationLease = await beginConversationMutation(id, auth.user!.id);
  if (!mutationLease) return jsonError('会话正在生成或修改，请稍后重试。', 409);
  let conversation: Awaited<ReturnType<typeof patchChatConversation>>;
  try {
    const currentOwnership = await assertConversationOwner(id, auth.user!.id, RESEARCH_REVIEW_KIND);
    if (!currentOwnership.conversation) return jsonError('会话不存在。', 404);
    if (!currentOwnership.allowed) return jsonError('无权访问该会话。', 403);
    conversation = await patchChatConversation(id, { thunder: body.thunder });
  } finally {
    await finishConversationRun(mutationLease).catch((error) => {
      console.error('[research-review] failed to release conversation-patch lease', error);
    });
  }
  await notifyChatConversationChanged({
    userId: auth.user!.id,
    conversationId: id,
    kind: RESEARCH_REVIEW_KIND,
    resource: 'metadata'
  });
  return NextResponse.json({ conversation });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const ownership = await assertConversationOwner(id, auth.user!.id, RESEARCH_REVIEW_KIND);
  if (!ownership.conversation) return jsonError('会话不存在。', 404);
  if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
  if (!await stopConversationGenerationAndSettle(id, auth.user!.id)) {
    return jsonError('当前生成仍在收尾，请稍后重试。', 409);
  }
  const mutationLease = await beginConversationMutation(id, auth.user!.id);
  if (!mutationLease) return jsonError('会话状态刚刚发生变化，请重试。', 409);
  try {
    const currentOwnership = await assertConversationOwner(id, auth.user!.id, RESEARCH_REVIEW_KIND);
    if (!currentOwnership.conversation) return jsonError('会话不存在。', 404);
    if (!currentOwnership.allowed) return jsonError('无权访问该会话。', 403);
    await deleteChatConversation(id);
  } finally {
    await finishConversationRun(mutationLease).catch((error) => {
      console.error('[research-review] failed to release conversation-delete lease', error);
    });
  }
  await notifyChatConversationChanged({
    userId: auth.user!.id,
    conversationId: id,
    kind: RESEARCH_REVIEW_KIND,
    action: 'delete'
  });
  return NextResponse.json({ ok: true });
}
