import { NextResponse } from 'next/server';
import {
  assertConversationOwner,
  deleteChatConversation,
  getChatConversationWithMessages,
  patchChatConversation
} from '@/lib/chat-history';
import { requireUser } from '@/lib/auth/request';
import { notifyChatConversationChanged } from '@/lib/chat-live';
import { beginConversationMutation, finishConversationRun, isConversationRunActive } from '@/lib/chat-run-registry';
import { harvestAgentDeliverables } from '@/lib/chat-deliverables';
import { stopConversationGenerationAndSettle } from '@/lib/chat-generation-stop';

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
  let data = await getChatConversationWithMessages(id);
  if (!data) return jsonError('会话不存在。', 404);
  const loadedOwnership = await assertConversationOwner(id, auth.user!.id, 'chat');
  if (
    !loadedOwnership.conversation
    || !loadedOwnership.allowed
    || data.conversation.user_id !== auth.user!.id
    || data.conversation.kind !== 'chat'
  ) {
    return jsonError('会话状态已发生变化，请刷新后重试。', 409);
  }
  const generating = await isConversationRunActive(id, auth.user!.id);
  // Recover files written by older Agent turns that predate the unified
  // attachment collector. This is idempotent: already-bound hashes are not
  // attached to a second message.
  if (!generating) {
    const recoveryLease = await beginConversationMutation(id, auth.user!.id);
    if (recoveryLease) {
      try {
        const lockedOwnership = await assertConversationOwner(id, auth.user!.id, 'chat');
        if (lockedOwnership.conversation && lockedOwnership.allowed) {
          const lockedData = await getChatConversationWithMessages(id);
          if (lockedData?.conversation.user_id === auth.user!.id && lockedData.conversation.kind === 'chat') {
            data = lockedData;
            const assistant = [...data.messages].reverse().find((message) => message.role === 'assistant');
            if (assistant) {
              const startedAtMs = assistant.createdAt ? Date.parse(assistant.createdAt) : NaN;
              const recovered = await harvestAgentDeliverables(id, assistant.id, {
                answer: assistant.content,
                ...(Number.isFinite(startedAtMs) ? { startedAtMs } : {})
              });
              if (recovered.length) {
                const refreshed = await getChatConversationWithMessages(id);
                if (refreshed?.conversation.user_id === auth.user!.id && refreshed.conversation.kind === 'chat') {
                  data = refreshed;
                }
              }
            }
          }
        }
      } catch (error) {
        console.warn('[chat] legacy deliverable recovery skipped', error);
      } finally {
        await finishConversationRun(recoveryLease).catch((error) => {
          console.error('[chat] failed to release deliverable-recovery lease', error);
        });
      }
    }
  }
  return NextResponse.json({
    ...data,
    generating,
    messages: generating
      ? data.messages
      : data.messages.map((message) => ({ ...message, inProgress: false }))
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const ownership = await assertConversationOwner(id, auth.user!.id, 'chat');
  if (!ownership.conversation) return jsonError('会话不存在。', 404);
  if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  // 【按线上版本还原】支持 chatModel / chat_model（arc / thunder / storm），thunder 保留兼容。
  if (!body || (!('thunder' in body) && !('chatModel' in body) && !('chat_model' in body))) {
    return jsonError('缺少更新字段。');
  }
  const mutationLease = await beginConversationMutation(id, auth.user!.id);
  if (!mutationLease) return jsonError('会话正在生成或修改，请稍后重试。', 409);
  let conversation: Awaited<ReturnType<typeof patchChatConversation>>;
  try {
    const currentOwnership = await assertConversationOwner(id, auth.user!.id, 'chat');
    if (!currentOwnership.conversation) return jsonError('会话不存在。', 404);
    if (!currentOwnership.allowed) return jsonError('无权访问该会话。', 403);
    conversation = await patchChatConversation(id, {
      ...('chatModel' in body || 'chat_model' in body
        ? { chatModel: body.chatModel ?? body.chat_model }
        : {}),
      ...('thunder' in body ? { thunder: body.thunder } : {})
    });
  } finally {
    await finishConversationRun(mutationLease).catch((error) => {
      console.error('[chat] failed to release conversation-patch lease', error);
    });
  }
  await notifyChatConversationChanged({
    userId: auth.user!.id,
    conversationId: id,
    kind: 'chat',
    resource: 'metadata'
  });
  return NextResponse.json({ conversation });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const ownership = await assertConversationOwner(id, auth.user!.id, 'chat');
  if (!ownership.conversation) return jsonError('会话不存在。', 404);
  if (!ownership.allowed) return jsonError('无权访问该会话。', 403);
  if (!await stopConversationGenerationAndSettle(id, auth.user!.id)) {
    return jsonError('当前生成仍在收尾，请稍后重试。', 409);
  }
  const mutationLease = await beginConversationMutation(id, auth.user!.id);
  if (!mutationLease) return jsonError('会话状态刚刚发生变化，请重试。', 409);
  try {
    const currentOwnership = await assertConversationOwner(id, auth.user!.id, 'chat');
    if (!currentOwnership.conversation) return jsonError('会话不存在。', 404);
    if (!currentOwnership.allowed) return jsonError('无权访问该会话。', 403);
    await deleteChatConversation(id);
  } finally {
    await finishConversationRun(mutationLease).catch((error) => {
      console.error('[chat] failed to release conversation-delete lease', error);
    });
  }
  await notifyChatConversationChanged({
    userId: auth.user!.id,
    conversationId: id,
    kind: 'chat',
    action: 'delete'
  });
  return NextResponse.json({ ok: true });
}
