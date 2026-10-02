import {
  assertConversationOwner,
  deleteChatMessage,
  getChatConversation,
  getChatMessages,
  revertChatMessagesFrom,
  type ChatHistoryMessage,
  type ConversationKind
} from '@/lib/chat-history';
import { stopConversationGenerationAndSettle } from '@/lib/chat-generation-stop';
import { beginConversationMutation, finishConversationRun } from '@/lib/chat-run-registry';
import { ensureChatWorkspace } from '@/lib/chat-generated-charts';
import { revertOpenCodeConversationWorkspace } from '@/lib/opencode/runtime';
import { researchReviewWorkspaceRoot } from '@/lib/opencode/research-review-workspace';
import { RESEARCH_REVIEW_SESSION_MAP } from '@/lib/research-review/constants';

export type ChatMessageActionResult =
  | { ok: true; messages: ChatHistoryMessage[] }
  | { ok: false; status: number; error: string };

async function authorizeMessageAction(
  conversationId: string,
  userId: string
): Promise<ChatMessageActionResult | { conversationId: string; kind: ConversationKind }> {
  const ownership = await assertConversationOwner(conversationId, userId);
  if (!ownership.conversation) {
    return { ok: false, status: 404, error: '会话不存在。' };
  }
  if (!ownership.allowed) {
    return { ok: false, status: 403, error: '无权访问该会话。' };
  }
  return { conversationId, kind: ownership.conversation.kind };
}

export async function revertConversationFromMessage(
  conversationId: string,
  userId: string,
  messageId: string
): Promise<ChatMessageActionResult> {
  const auth = await authorizeMessageAction(conversationId, userId);
  if ('ok' in auth) return auth;
  const settled = await stopConversationGenerationAndSettle(conversationId, userId);
  if (!settled) {
    return { ok: false, status: 409, error: '当前生成仍在收尾，请稍后重试。' };
  }
  const mutationLease = await beginConversationMutation(conversationId, userId);
  if (!mutationLease) {
    return { ok: false, status: 409, error: '会话状态刚刚发生变化，请重试。' };
  }
  try {
    const lockedOwnership = await assertConversationOwner(conversationId, userId, auth.kind);
    if (!lockedOwnership.conversation) {
      return { ok: false, status: 404, error: '会话不存在。' };
    }
    if (!lockedOwnership.allowed) {
      return { ok: false, status: 403, error: '无权访问该会话。' };
    }
    const stored = await getChatMessages(conversationId);
    const targetIndex = stored.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) return { ok: false, status: 404, error: '无法定位要回撤的消息。' };
    const target = stored[targetIndex];
    let userPrompt = target.role === 'user' ? target.content : '';
    if (!userPrompt) {
      for (let i = targetIndex - 1; i >= 0; i -= 1) {
        if (stored[i].role === 'user') {
          userPrompt = stored[i].content;
          break;
        }
      }
    }

    const conversation = await getChatConversation(conversationId);
    const isReview = conversation?.kind === 'research-review';
    await revertOpenCodeConversationWorkspace(conversationId, {
      userPrompt,
      workingDirectory: isReview
        ? researchReviewWorkspaceRoot(conversationId)
        : ensureChatWorkspace(conversationId),
      sessionMapFile: isReview ? RESEARCH_REVIEW_SESSION_MAP : undefined
    });

    const reverted = await revertChatMessagesFrom(conversationId, messageId);
    if (!reverted) return { ok: false, status: 404, error: '无法定位要回撤的消息。' };
    return { ok: true, messages: await getChatMessages(conversationId) };
  } finally {
    await finishConversationRun(mutationLease).catch((error) => {
      console.error('[chat-message-actions] failed to release revert lease', error);
    });
  }
}

export async function deleteConversationMessage(
  conversationId: string,
  userId: string,
  messageId: string
): Promise<ChatMessageActionResult> {
  const auth = await authorizeMessageAction(conversationId, userId);
  if ('ok' in auth) return auth;
  const settled = await stopConversationGenerationAndSettle(conversationId, userId);
  if (!settled) {
    return { ok: false, status: 409, error: '当前生成仍在收尾，请稍后重试。' };
  }
  const mutationLease = await beginConversationMutation(conversationId, userId);
  if (!mutationLease) {
    return { ok: false, status: 409, error: '会话状态刚刚发生变化，请重试。' };
  }
  try {
    const lockedOwnership = await assertConversationOwner(conversationId, userId, auth.kind);
    if (!lockedOwnership.conversation) {
      return { ok: false, status: 404, error: '会话不存在。' };
    }
    if (!lockedOwnership.allowed) {
      return { ok: false, status: 403, error: '无权访问该会话。' };
    }
    const deleted = await deleteChatMessage(conversationId, messageId);
    if (!deleted) return { ok: false, status: 404, error: '消息不存在。' };
    return { ok: true, messages: await getChatMessages(conversationId) };
  } finally {
    await finishConversationRun(mutationLease).catch((error) => {
      console.error('[chat-message-actions] failed to release delete lease', error);
    });
  }
}
