export type ConversationLoadGuard = {
  requestSeq: number;
  latestSeq: number;
  requestedConversationId: string;
  activeConversationIdAtStart: string;
  currentConversationId: string;
  userIdAtStart: string;
  currentUserId: string;
};

export function canApplyConversationLoad(guard: ConversationLoadGuard) {
  return guard.requestSeq === guard.latestSeq
    && guard.userIdAtStart === guard.currentUserId
    && (
      guard.currentConversationId === guard.activeConversationIdAtStart
      || guard.currentConversationId === guard.requestedConversationId
    );
}

export function canRefreshViewedConversation(
  viewingConversationId: string,
  pendingConversationId: string
) {
  return !pendingConversationId || pendingConversationId === viewingConversationId;
}

export type RemoteConversationSyncIdentity = {
  conversationId: string;
  assistantId: string;
};

export function canApplyRemoteConversationHydration(
  viewingConversationId: string,
  requestedConversationId: string,
  assistantId: string,
  expectedSync: RemoteConversationSyncIdentity,
  currentSync: RemoteConversationSyncIdentity | null
) {
  return viewingConversationId === requestedConversationId
    && currentSync === expectedSync
    && expectedSync.conversationId === requestedConversationId
    && expectedSync.assistantId === assistantId;
}

export function shouldUpdateActiveConversationTitle(
  conversationId: string,
  activeConversationId: string
) {
  return Boolean(conversationId) && conversationId === activeConversationId;
}
