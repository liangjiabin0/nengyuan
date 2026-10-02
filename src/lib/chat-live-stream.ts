import { CHAT_NDJSON_HEADERS, CHAT_STREAM_HEARTBEAT_MS } from './chat-ndjson-stream';
import {
  hasChatLiveReplayOverflow,
  latestChatLiveSeq,
  listChatLiveEvents,
  subscribeChatLive,
  type ChatLiveEvent
} from './chat-live';

const CHAT_LIVE_REPLAY_LIMIT = 20_000;
const CHAT_LIVE_REPLAY_PAGE_SIZE = 1_000;
const CHAT_LIVE_AUTH_CHECK_MS = 30_000;

type ChatLiveStreamDependencies = {
  subscribe: typeof subscribeChatLive;
  latestSeq: typeof latestChatLiveSeq;
  listEvents: typeof listChatLiveEvents;
  hasReplayOverflow: typeof hasChatLiveReplayOverflow;
};

type CreateChatLiveResponseInput = {
  request: Request;
  userId: string;
  requestedAfter: number | null;
  reauthorize: () => Promise<boolean>;
  dependencies?: Partial<ChatLiveStreamDependencies>;
  heartbeatMs?: number;
  authCheckMs?: number;
  replayLimit?: number;
};

function encodeEvent(event: ChatLiveEvent) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export function createChatLiveResponse(input: CreateChatLiveResponseInput) {
  const dependencies: ChatLiveStreamDependencies = {
    subscribe: subscribeChatLive,
    latestSeq: latestChatLiveSeq,
    listEvents: listChatLiveEvents,
    hasReplayOverflow: hasChatLiveReplayOverflow,
    ...input.dependencies
  };
  const heartbeatMs = Math.max(1, input.heartbeatMs ?? CHAT_STREAM_HEARTBEAT_MS);
  const authCheckMs = Math.max(0, input.authCheckMs ?? CHAT_LIVE_AUTH_CHECK_MS);
  const replayLimit = Math.max(0, Math.floor(input.replayLimit ?? CHAT_LIVE_REPLAY_LIMIT));
  let close: () => void = () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let cleaned = false;
      let lastSentSeq = 0;
      let replaying = true;
      let unsubscribe: () => void = () => undefined;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let authCheckRunning = false;
      let lastAuthCheckAt = Date.now();
      let abortListenerAttached = false;
      const pending: ChatLiveEvent[] = [];

      close = () => {
        if (cleaned) return;
        cleaned = true;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (abortListenerAttached) {
          input.request.signal.removeEventListener('abort', close);
          abortListenerAttached = false;
        }
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const send = (event: ChatLiveEvent) => {
        if (closed) return;
        const seq = Number(event.seq || 0);
        if (seq > 0 && seq <= lastSentSeq) return;
        try {
          controller.enqueue(encodeEvent(event));
          if (seq > 0) lastSentSeq = seq;
        } catch {
          close();
        }
      };

      const subscribedUnsubscribe = await dependencies.subscribe(input.userId, (event) => {
        if (replaying) pending.push(event);
        else send(event);
      });
      if (closed || input.request.signal.aborted) {
        subscribedUnsubscribe();
        return;
      }
      unsubscribe = subscribedUnsubscribe;

      try {
        const replayThrough = await dependencies.latestSeq(input.userId);
        if (closed) return;
        const requestedAfter = input.requestedAfter == null
          ? replayThrough
          : Math.max(0, Math.floor(input.requestedAfter));
        const afterSeq = Math.min(requestedAfter, replayThrough);
        const overflow = await dependencies.hasReplayOverflow(
          input.userId,
          afterSeq,
          replayThrough,
          replayLimit
        );
        if (closed) return;

        if (overflow) {
          send({ type: 'hello', userId: input.userId, seq: replayThrough, reset: true });
        } else {
          send({ type: 'hello', userId: input.userId, seq: afterSeq });
          let cursor = afterSeq;
          while (cursor < replayThrough && !closed) {
            const events = await dependencies.listEvents(
              input.userId,
              cursor,
              CHAT_LIVE_REPLAY_PAGE_SIZE,
              replayThrough
            );
            if (!events.length) break;
            for (const event of events) {
              send(event);
              cursor = Math.max(cursor, Number(event.seq || 0));
            }
            if (events.length < CHAT_LIVE_REPLAY_PAGE_SIZE) break;
          }
        }
      } catch (error) {
        console.error('[chat-live] replay failed', error);
        close();
      } finally {
        replaying = false;
        pending.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
        for (const event of pending) send(event);
        pending.length = 0;
      }

      if (input.request.signal.aborted || closed) {
        close();
        return;
      }

      const checkAuthorization = async () => {
        if (closed || authCheckRunning) return;
        authCheckRunning = true;
        try {
          if (!await input.reauthorize()) close();
        } catch {
          close();
        } finally {
          authCheckRunning = false;
        }
      };

      heartbeat = setInterval(() => {
        send({ type: 'ping', userId: input.userId });
        const now = Date.now();
        if (now - lastAuthCheckAt < authCheckMs) return;
        lastAuthCheckAt = now;
        void checkAuthorization();
      }, heartbeatMs);
      input.request.signal.addEventListener('abort', close, { once: true });
      abortListenerAttached = true;
    },
    cancel() {
      close();
    }
  });

  return new Response(stream, { headers: CHAT_NDJSON_HEADERS });
}
