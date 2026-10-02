import {
  CHAT_LIVE_PATH,
  type ChatLiveEvent,
  isChatLiveHeartbeatEvent
} from './chat-live-protocol';

export type RemoteStreamEvent = {
  type?: string;
  content?: string;
};

export type ChatLiveRunIdentity = {
  conversationId: string;
  userMessageId?: string;
  assistantMessageId?: string;
};

export type ChatLiveConnectionState = {
  connection: number;
  reconnected: boolean;
  resynced?: boolean;
};

export function isChatLiveEventFromRun(event: ChatLiveEvent, run: ChatLiveRunIdentity) {
  if (!event.conversationId || event.conversationId !== run.conversationId) return false;
  let identified = false;
  if (event.userMessageId) {
    identified = true;
    if (event.userMessageId !== run.userMessageId) return false;
  }
  if (event.assistantMessageId) {
    identified = true;
    if (event.assistantMessageId !== run.assistantMessageId) return false;
  }
  return identified;
}

export function shouldRefreshSendQueue(event: ChatLiveEvent) {
  if (event.type !== 'list') return false;
  const detail = event.event as { resource?: string } | undefined;
  return detail?.resource === 'send-queue';
}

export function shouldRefreshActiveConversation(
  event: ChatLiveEvent,
  viewingConversationId: string
) {
  if (event.type !== 'conversation' || event.conversationId !== viewingConversationId) return false;
  const detail = event.event as { resource?: string } | undefined;
  return detail?.resource === 'messages'
    || detail?.resource === 'attachments'
    || detail?.resource === 'metadata';
}

export function chatLiveUrlWithCursor(url: string, afterSeq: number) {
  const cursor = Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
  if (!cursor) return url;
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf('?');
  const path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '');
  params.set('after', String(cursor));
  return `${path}?${params.toString()}${hash}`;
}

export function shouldRefreshConversationList(event: ChatLiveEvent) {
  if (event.type === 'conversation' || event.type === 'delete' || event.type === 'list') return true;
  if (event.type !== 'stream') return false;
  const inner = event.event as { type?: string } | undefined;
  return inner?.type === 'meta'
    || inner?.type === 'title'
    || inner?.type === 'done'
    || inner?.type === 'error';
}

export function shouldApplyRemoteStream(
  event: ChatLiveEvent,
  viewingConversationId: string,
  isLocalOriginator: boolean
) {
  if (isLocalOriginator || event.type !== 'stream' || !event.conversationId) return false;
  return event.conversationId === viewingConversationId;
}

export function shouldSeedRemoteTurn(
  event: ChatLiveEvent,
  viewingConversationId: string,
  isLocalOriginator: boolean
) {
  if (isLocalOriginator || !event.conversationId || event.conversationId !== viewingConversationId) {
    return false;
  }
  return Boolean(event.userMessageId || event.assistantMessageId || event.userContent);
}

export function isIncrementalStreamEvent(event: { type?: string } | null | undefined) {
  const type = event?.type;
  return type === 'chunk' || type === 'answer_reset' || type === 'answer_replace';
}

export function replayQueuedAnswer(events: RemoteStreamEvent[]) {
  let answer = '';
  for (const event of events) {
    if (event.type === 'answer_reset') answer = '';
    else if (event.type === 'answer_replace') answer = String(event.content || '');
    else if (event.type === 'chunk') answer += String(event.content || '');
  }
  return answer;
}

export function reconcileStreamAfterSnapshot(input: {
  snapshotContent: string;
  queued: RemoteStreamEvent[];
}) {
  const live = replayQueuedAnswer(input.queued);
  const snap = input.snapshotContent || '';
  if (!live) return { content: snap, replace: false };
  if (!snap) return { content: live, replace: true };
  if (live.startsWith(snap) || snap.startsWith(live)) {
    return { content: live.length >= snap.length ? live : snap, replace: live.length > snap.length };
  }
  return { content: live.length >= snap.length ? live : snap, replace: live.length >= snap.length };
}

export async function consumeChatLive(input: {
  url?: string;
  signal: AbortSignal;
  onEvent: (event: ChatLiveEvent) => void;
  onConnected?: (state: ChatLiveConnectionState) => void;
  onDisconnected?: () => void;
  fetchImpl?: typeof fetch;
}) {
  const delays = [400, 800, 1_600, 3_000];
  let attempt = 0;
  let connection = 0;
  let lastSeq = 0;
  const fetchImpl = input.fetchImpl || fetch;
  while (!input.signal.aborted) {
    let notifiedDisconnect = false;
    try {
      const response = await fetchImpl(chatLiveUrlWithCursor(input.url || CHAT_LIVE_PATH, lastSeq), {
        method: 'GET',
        headers: { Accept: 'application/x-ndjson' },
        cache: 'no-store',
        signal: input.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`live ${response.status || 'unavailable'}`);
      }
      attempt = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let connectedNotified = false;
      while (!input.signal.aborted) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            try {
              const event = JSON.parse(line) as ChatLiveEvent;
              const seq = Number(event.seq || 0);
              if (event.type === 'hello') {
                if (seq > 0) lastSeq = Math.max(lastSeq, seq);
                if (!connectedNotified) {
                  connectedNotified = true;
                  connection += 1;
                  input.onConnected?.({
                    connection,
                    reconnected: connection > 1,
                    ...(event.reset ? { resynced: true } : {})
                  });
                }
                newline = buffer.indexOf('\n');
                continue;
              }
              if (!connectedNotified) {
                newline = buffer.indexOf('\n');
                continue;
              }
              if (seq > 0 && seq <= lastSeq) {
                newline = buffer.indexOf('\n');
                continue;
              }
              if (seq > 0) lastSeq = seq;
              if (!isChatLiveHeartbeatEvent(event)) input.onEvent(event);
            } catch {
              // skip malformed live frames
            }
          }
          newline = buffer.indexOf('\n');
        }
        if (done) break;
      }
    } catch (error) {
      if (input.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error || '');
      if (/abort/i.test(message)) return;
      notifiedDisconnect = true;
      input.onDisconnected?.();
    }
    if (input.signal.aborted) return;
    if (!notifiedDisconnect) input.onDisconnected?.();
    const wait = delays[Math.min(attempt, delays.length - 1)];
    attempt += 1;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const timer = setTimeout(finish, wait);
      const onAbort = () => finish();
      if (input.signal.aborted) {
        finish();
        return;
      }
      input.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
