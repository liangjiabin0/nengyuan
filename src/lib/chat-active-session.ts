export type ActiveConversationSession = {
  conversationId: string;
  kind: 'chat' | 'research-review';
};

function keySegment(value: string | null | undefined, fallback: string) {
  return encodeURIComponent(String(value || '').trim() || fallback);
}

export function activeConversationStorageKey(scope: string, userId: string | null | undefined) {
  return `ai4es:active-conversation:${keySegment(userId, 'anonymous')}:${keySegment(scope, 'chat')}`;
}

export function readActiveConversation(
  scope: string,
  userId: string | null | undefined
): ActiveConversationSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(activeConversationStorageKey(scope, userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveConversationSession>;
    if (!parsed.conversationId || typeof parsed.conversationId !== 'string') return null;
    const kind = parsed.kind === 'research-review' ? parsed.kind : 'chat';
    return { conversationId: parsed.conversationId, kind };
  } catch {
    return null;
  }
}

export function writeActiveConversation(
  scope: string,
  userId: string | null | undefined,
  session: ActiveConversationSession | null
) {
  if (typeof window === 'undefined') return;
  try {
    const key = activeConversationStorageKey(scope, userId);
    if (!session?.conversationId) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify(session));
  } catch {
    // private mode / quota
  }
}

export function unreadCompletedStorageKey(userId: string | null | undefined) {
  return `ai4es:unread-completed-conversations:${keySegment(userId, 'anonymous')}`;
}

export function readUnreadCompletedConversations(userId: string | null | undefined): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(unreadCompletedStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function writeUnreadCompletedConversations(
  userId: string | null | undefined,
  ids: string[]
) {
  if (typeof window === 'undefined') return;
  try {
    const key = unreadCompletedStorageKey(userId);
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify(unique));
  } catch {
    // private mode / quota
  }
}

export function isInFlightAssistantMessage(message: {
  role?: string;
  inProgress?: boolean;
}) {
  return message.role === 'assistant' && message.inProgress === true;
}
