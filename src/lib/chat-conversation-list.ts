import { parseChatTimestampMs } from './chat-thinking-duration';

export type ConversationListSortFields = {
  last_user_at?: string | null;
  created_at?: string | null;
};

export function conversationLastUserMs(conversation: ConversationListSortFields) {
  return parseChatTimestampMs(conversation.last_user_at || undefined)
    ?? parseChatTimestampMs(conversation.created_at || undefined)
    ?? 0;
}

export function newerConversationTimestamp(left?: string | null, right?: string | null) {
  const leftMs = parseChatTimestampMs(left || undefined) ?? 0;
  const rightMs = parseChatTimestampMs(right || undefined) ?? 0;
  if (rightMs > leftMs) return right || '';
  if (leftMs > rightMs) return left || '';
  return left || right || '';
}

/** Newest last-user-message first. Token / assistant updates must not affect this order. */
export function sortConversationsByLastUser<T extends ConversationListSortFields>(items: T[]) {
  return [...items].sort((left, right) => {
    const byUser = conversationLastUserMs(right) - conversationLastUserMs(left);
    if (byUser) return byUser;
    return (parseChatTimestampMs(right.created_at || undefined) ?? 0)
      - (parseChatTimestampMs(left.created_at || undefined) ?? 0);
  });
}
