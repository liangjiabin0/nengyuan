import { getChatMessageScope, upsertChatMessage, type ChatSource } from '@/lib/chat-history';
import type { ModelContextUsage, RuntimeAgentStep } from '@/lib/opencode/types';

export const CHAT_MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveChatMessageId(value: unknown) {
  const id = typeof value === 'string' ? value.trim() : '';
  return CHAT_MESSAGE_ID_RE.test(id) ? id : crypto.randomUUID();
}

/** Accept a client correlation ID only when it cannot address another persisted message. */
export async function resolveAssistantMessageId(value: unknown, conversationId: string) {
  const requestedId = typeof value === 'string' ? value.trim() : '';
  if (!CHAT_MESSAGE_ID_RE.test(requestedId)) return crypto.randomUUID();

  const existing = await getChatMessageScope(requestedId);
  if (!existing) return requestedId;
  if (existing.conversation_id === conversationId && existing.role === 'assistant') {
    return requestedId;
  }
  return crypto.randomUUID();
}

export type AssistantTurnSnapshot = {
  id: string;
  conversationId: string;
  content: string;
  sources?: ChatSource[];
  graphSeedIds?: string[];
  agentSteps?: RuntimeAgentStep[];
  thinkingDurationMs?: number;
  contextUsage?: ModelContextUsage;
};

const PERSIST_MIN_INTERVAL_MS = 1_500;

export function createAssistantTurnPersister() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPersistAt = 0;
  let pending: AssistantTurnSnapshot | null = null;
  let writing: Promise<void> = Promise.resolve();
  let finalized = false;

  const write = (snapshot: AssistantTurnSnapshot, inProgress: boolean) => {
    const operation = writing.catch(() => undefined).then(async () => {
      await upsertChatMessage({
        ...snapshot,
        role: 'assistant',
        inProgress
      });
    });
    writing = operation.catch((error) => {
      console.error('[chat] persist assistant turn failed', error);
    });
    return operation;
  };

  return {
    schedule(snapshot: AssistantTurnSnapshot) {
      if (finalized) return;
      pending = snapshot;
      const elapsed = Date.now() - lastPersistAt;
      if (elapsed >= PERSIST_MIN_INTERVAL_MS && !timer) {
        lastPersistAt = Date.now();
        void write(snapshot, true).catch(() => undefined);
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        if (!next) return;
        lastPersistAt = Date.now();
        void write(next, true).catch(() => undefined);
      }, Math.max(200, PERSIST_MIN_INTERVAL_MS - elapsed));
    },
    async flush(snapshot: AssistantTurnSnapshot, inProgress: boolean) {
      if (finalized && inProgress) return;
      if (!inProgress) finalized = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pending = snapshot;
      lastPersistAt = Date.now();
      await write(snapshot, inProgress);
    }
  };
}
