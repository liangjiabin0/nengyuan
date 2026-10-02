export const CHAT_LIVE_PATH = '/api/chat/live';

export type ChatLiveKind = 'chat' | 'research-review';

export type ChatLiveEvent = {
  type: 'hello' | 'ping' | 'list' | 'conversation' | 'delete' | 'stream';
  userId?: string;
  conversationId?: string;
  kind?: ChatLiveKind;
  generating?: boolean;
  userMessageId?: string;
  assistantMessageId?: string;
  userContent?: string;
  event?: unknown;
  seq?: number;
  at?: number;
  reset?: boolean;
};

export function isChatLiveHeartbeatEvent(event: unknown) {
  if (!event || typeof event !== 'object') return false;
  const rec = event as { type?: string; phase?: string };
  return rec.type === 'ping'
    || rec.type === 'hello'
    || (rec.type === 'status' && rec.phase === 'heartbeat');
}
