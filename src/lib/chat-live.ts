import { all, get, run, withTransaction } from '@/lib/db';
import {
  isChatLiveHeartbeatEvent,
  type ChatLiveEvent,
  type ChatLiveKind
} from '@/lib/chat-live-protocol';

export {
  CHAT_LIVE_PATH,
  isChatLiveHeartbeatEvent,
  type ChatLiveEvent,
  type ChatLiveKind
} from '@/lib/chat-live-protocol';

type ChatLiveListener = (event: ChatLiveEvent) => void;

type ChatLiveEventRow = {
  seq: number;
  user_id: string;
  event_json: string;
  created_at_ms: number;
};

const listeners = new Map<string, Set<ChatLiveListener>>();
const deliveredSeq = new Map<string, number>();
const publishChains = new Map<string, Promise<void>>();
const CHAT_LIVE_POLL_MS = 250;
const CHAT_LIVE_REPLAY_RETENTION_MS = 24 * 60 * 60 * 1_000;
let testNextSeq = 0;
let memoryOnlyForTests = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRunning = false;
let lastPrunedAt = 0;

export function resetChatLiveForTests() {
  listeners.clear();
  deliveredSeq.clear();
  publishChains.clear();
  testNextSeq = 0;
  memoryOnlyForTests = true;
  stopPoller();
}

export function chatLiveSubscriberCount(userId?: string) {
  if (!userId) {
    let total = 0;
    for (const group of listeners.values()) total += group.size;
    return total;
  }
  return listeners.get(userId)?.size || 0;
}

export async function subscribeChatLive(userId: string, listener: ChatLiveListener) {
  if (!userId) return () => undefined;
  if (!memoryOnlyForTests && !deliveredSeq.has(userId)) {
    const latest = await get<{ seq: number }>(
      'SELECT seq FROM chat_live_events WHERE user_id = ? ORDER BY seq DESC LIMIT 1',
      [userId]
    );
    deliveredSeq.set(userId, Number(latest?.seq || 0));
  }
  const group = listeners.get(userId) || new Set<ChatLiveListener>();
  group.add(listener);
  listeners.set(userId, group);
  startPoller();
  return () => {
    const current = listeners.get(userId);
    if (!current) return;
    current.delete(listener);
    if (!current.size) {
      listeners.delete(userId);
      deliveredSeq.delete(userId);
    }
    if (!listeners.size) stopPoller();
  };
}

export function publishChatLive(userId: string, event: ChatLiveEvent) {
  if (!userId) return Promise.resolve();
  const previous = publishChains.get(userId) || Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => persistChatLiveEvent(userId, event));
  publishChains.set(userId, operation);
  void operation.finally(() => {
    if (publishChains.get(userId) === operation) publishChains.delete(userId);
  });
  return operation;
}

async function persistChatLiveEvent(userId: string, event: ChatLiveEvent) {
  const at = Date.now();
  if (memoryOnlyForTests) {
    deliverChatLiveEvent({ ...event, userId, seq: ++testNextSeq, at });
    return;
  }
  try {
    const rows = await withTransaction(async (database) => {
      // PostgreSQL sequences can become visible out of commit order. Serialize
      // each user's inserts so a reconnect cursor can never skip a late commit.
      await database.prepare(
        `SELECT pg_advisory_xact_lock(hashtext('chat_live_events'), hashtext(?)) AS locked`
      ).get(userId);
      return database.prepare(
        `INSERT INTO chat_live_events (user_id, event_json, created_at_ms)
         VALUES (?, ?, ?)
         RETURNING seq`
      ).all<{ seq: number }>(userId, JSON.stringify(event), at);
    });
    const row = rows[0];
    if (!row?.seq) throw new Error('chat live event insert returned no sequence');
    await deliverPersistedChatLiveEventsThrough(userId, Number(row.seq));
    void pruneChatLiveEvents();
  } catch (error) {
    console.error('[chat-live] durable publish failed', error);
    deliverWithoutSequence({ ...event, userId, at });
  }
}

async function deliverPersistedChatLiveEventsThrough(userId: string, throughSeq: number) {
  const afterSeq = deliveredSeq.get(userId) || 0;
  const rows = await all<ChatLiveEventRow>(
    `SELECT seq, user_id, event_json, created_at_ms
     FROM chat_live_events
     WHERE user_id = ? AND seq > ? AND seq <= ?
     ORDER BY seq ASC`,
    [userId, afterSeq, throughSeq]
  );
  for (const row of rows) {
    const persisted = mapEventRow(row);
    if (persisted) deliverChatLiveEvent(persisted);
  }
}

function currentListeners(group: Set<ChatLiveListener>) {
  return [...group];
}

export function shouldPublishChatStreamEvent(event: unknown) {
  if (!event || typeof event !== 'object') return false;
  const rec = event as { type?: string; phase?: string };
  if (!rec.type) return false;
  return !isChatLiveHeartbeatEvent(event);
}

export async function publishChatStreamEvent(input: {
  userId: string;
  conversationId: string;
  kind?: ChatLiveKind;
  userMessageId?: string;
  assistantMessageId?: string;
  userContent?: string;
  event: unknown;
}) {
  if (!input.userId || !input.conversationId || !shouldPublishChatStreamEvent(input.event)) return;
  const inner = input.event as { type?: string };
  await publishChatLive(input.userId, {
    type: 'stream',
    conversationId: input.conversationId,
    kind: input.kind,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    ...(inner.type === 'meta' ? { userContent: input.userContent, generating: true } : {}),
    ...(inner.type === 'done' || inner.type === 'error' ? { generating: false } : {}),
    event: input.event
  });
}

export function createChatStreamPublisher(input: {
  userId: string;
  conversationId: string;
  kind?: ChatLiveKind;
  userMessageId?: string;
  assistantMessageId?: string;
  userContent?: string;
}) {
  let pendingChunk = '';
  let chunkTimer: ReturnType<typeof setTimeout> | null = null;
  let tail = Promise.resolve();

  const append = (event: unknown) => {
    tail = tail
      .catch(() => undefined)
      .then(() => publishChatStreamEvent({ ...input, event }));
  };
  const flushChunk = () => {
    if (chunkTimer) clearTimeout(chunkTimer);
    chunkTimer = null;
    if (!pendingChunk) return;
    const content = pendingChunk;
    pendingChunk = '';
    append({ type: 'chunk', content });
  };

  return {
    publish(event: unknown) {
      if (!shouldPublishChatStreamEvent(event)) return;
      const inner = event as { type?: string; content?: unknown };
      if (inner.type === 'chunk') {
        pendingChunk += String(inner.content || '');
        if (!chunkTimer) {
          chunkTimer = setTimeout(flushChunk, 40);
          chunkTimer.unref?.();
        }
        return;
      }
      flushChunk();
      append(event);
    },
    async flush() {
      flushChunk();
      await tail;
    }
  };
}

export async function notifyChatConversationChanged(input: {
  userId: string;
  conversationId: string;
  kind?: ChatLiveKind;
  action?: 'upsert' | 'delete';
  generating?: boolean;
  userMessageId?: string;
  assistantMessageId?: string;
  userContent?: string;
  resource?: 'attachments' | 'messages' | 'metadata';
}) {
  if (!input.userId || !input.conversationId) return;
  await publishChatLive(input.userId, {
    type: input.action === 'delete' ? 'delete' : 'conversation',
    conversationId: input.conversationId,
    kind: input.kind,
    generating: input.generating,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    userContent: input.userContent,
    event: input.resource ? { resource: input.resource } : undefined
  });
}

export async function listChatLiveEvents(
  userId: string,
  afterSeq: number,
  limit = 1_000,
  throughSeq?: number
) {
  if (!userId || memoryOnlyForTests) return [];
  const safeAfter = Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
  const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit) || 1_000));
  const safeThrough = Number.isFinite(throughSeq)
    ? Math.max(0, Math.floor(Number(throughSeq)))
    : null;
  if (safeThrough != null && safeThrough <= safeAfter) return [];
  const rows = await all<ChatLiveEventRow>(
    `SELECT seq, user_id, event_json, created_at_ms
     FROM chat_live_events
     WHERE user_id = ? AND seq > ?${safeThrough == null ? '' : ' AND seq <= ?'}
     ORDER BY seq ASC
     LIMIT ?`,
    safeThrough == null
      ? [userId, safeAfter, safeLimit]
      : [userId, safeAfter, safeThrough, safeLimit]
  );
  return rows.map(mapEventRow).filter((event): event is ChatLiveEvent => Boolean(event));
}

export async function hasChatLiveReplayOverflow(
  userId: string,
  afterSeq: number,
  throughSeq: number,
  limit: number
) {
  if (!userId || memoryOnlyForTests) return false;
  const safeAfter = Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
  const safeThrough = Number.isFinite(throughSeq) ? Math.max(0, Math.floor(throughSeq)) : 0;
  const safeLimit = Math.max(0, Math.floor(limit) || 0);
  if (safeThrough <= safeAfter) return false;
  const row = await get<{ seq: number }>(
    `SELECT seq
     FROM chat_live_events
     WHERE user_id = ? AND seq > ? AND seq <= ?
     ORDER BY seq ASC
     LIMIT 1 OFFSET ?`,
    [userId, safeAfter, safeThrough, safeLimit]
  );
  return Boolean(row?.seq);
}

export async function latestChatLiveSeq(userId: string) {
  if (!userId) return 0;
  if (memoryOnlyForTests) return testNextSeq;
  const row = await get<{ seq: number }>(
    'SELECT seq FROM chat_live_events WHERE user_id = ? ORDER BY seq DESC LIMIT 1',
    [userId]
  );
  return Number(row?.seq || 0);
}

function mapEventRow(row: ChatLiveEventRow): ChatLiveEvent | null {
  try {
    const parsed = JSON.parse(row.event_json) as ChatLiveEvent;
    if (!parsed || typeof parsed !== 'object' || !parsed.type) return null;
    return {
      ...parsed,
      userId: row.user_id,
      seq: Number(row.seq),
      at: Number(row.created_at_ms)
    };
  } catch {
    return null;
  }
}

function deliverChatLiveEvent(event: ChatLiveEvent) {
  const userId = event.userId || '';
  if (!userId) return;
  const seq = Number(event.seq || 0);
  const previous = deliveredSeq.get(userId) || 0;
  if (seq > 0 && seq <= previous) return;
  if (seq > 0) deliveredSeq.set(userId, seq);
  deliverWithoutSequence(event);
}

function deliverWithoutSequence(event: ChatLiveEvent) {
  const group = listeners.get(event.userId || '');
  if (!group?.size) return;
  for (const listener of currentListeners(group)) {
    try {
      listener(event);
    } catch (error) {
      console.error('[chat-live] subscriber failed', error);
    }
  }
}

function startPoller() {
  if (memoryOnlyForTests || pollTimer || !listeners.size) return;
  pollTimer = setInterval(() => void pollChatLiveEvents(), CHAT_LIVE_POLL_MS);
  pollTimer.unref?.();
}

function stopPoller() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollChatLiveEvents() {
  if (pollRunning || !listeners.size || memoryOnlyForTests) return;
  pollRunning = true;
  try {
    const users = [...listeners.keys()];
    const conditions = users.map(() => '(user_id = ? AND seq > ?)').join(' OR ');
    const params = users.flatMap((userId) => [userId, deliveredSeq.get(userId) || 0]);
    const rows = await all<ChatLiveEventRow>(
      `SELECT seq, user_id, event_json, created_at_ms
       FROM chat_live_events
       WHERE ${conditions}
       ORDER BY seq ASC
       LIMIT 5000`,
      params
    );
    for (const row of rows) {
      const event = mapEventRow(row);
      if (event) deliverChatLiveEvent(event);
    }
  } catch (error) {
    console.error('[chat-live] cross-instance poll failed', error);
  } finally {
    pollRunning = false;
  }
}

async function pruneChatLiveEvents() {
  const now = Date.now();
  if (now - lastPrunedAt < 60 * 60 * 1_000) return;
  lastPrunedAt = now;
  try {
    await run('DELETE FROM chat_live_events WHERE created_at_ms < ?', [now - CHAT_LIVE_REPLAY_RETENTION_MS]);
  } catch (error) {
    console.warn('[chat-live] retention cleanup failed', error);
  }
}
