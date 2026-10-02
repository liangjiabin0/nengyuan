import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { all, get, run, type Database } from '@/lib/db';
import { getConversationRunLockPool } from '@/lib/db/pg-database';

const RUN_HEARTBEAT_MS = 1_000;
export const CHAT_QUEUE_MUTATION_LOCK_NAMESPACE = 'chat_queue_mutation';
const instanceId = `${process.pid}:${crypto.randomUUID()}`;

export type ConversationRunHandle = {
  conversationId: string;
  runId: string;
  userId: string;
  status: 'running' | 'mutation';
  controller: AbortController;
  heartbeat: ReturnType<typeof setInterval>;
  lockClient: PoolClient;
  lockReleased: boolean;
  lockErrorListener: (error: Error) => void;
};

const runs = new Map<string, ConversationRunHandle>();

export async function lockConversationQueueMutation(
  database: Database,
  conversationId: string
) {
  await database.prepare(
    `SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?)) AS locked`
  ).get(CHAT_QUEUE_MUTATION_LOCK_NAMESPACE, conversationId);
}

async function acquireConversationLease(
  conversationId: string,
  userId: string,
  status: ConversationRunHandle['status']
) {
  const runId = crypto.randomUUID();
  const lockClient = await getConversationRunLockPool().connect();
  try {
    const lockResult = await lockClient.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked`,
      ['chat_conversation_run', conversationId]
    );
    if (!lockResult.rows[0]?.locked) {
      lockClient.release();
      return null;
    }

    const acquiredRows = await all<{ run_id: string }>(
      `INSERT INTO chat_conversation_runs
         (conversation_id, run_id, user_id, owner_instance_id, status, started_at, heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW(), NOW() + INTERVAL '15 seconds')
       ON CONFLICT (conversation_id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         user_id = EXCLUDED.user_id,
         owner_instance_id = EXCLUDED.owner_instance_id,
         status = EXCLUDED.status,
         started_at = NOW(),
         heartbeat_at = NOW(),
         expires_at = NOW() + INTERVAL '15 seconds'
       RETURNING run_id`,
      [conversationId, runId, userId, instanceId, status]
    );
    const acquired = acquiredRows[0];
    if (acquired?.run_id !== runId) {
      await lockClient.query(
        `SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`,
        ['chat_conversation_run', conversationId]
      );
      lockClient.release();
      return null;
    }
  } catch (error) {
    lockClient.release(true);
    throw error;
  }

  const controller = new AbortController();
  const handle = {
    conversationId,
    runId,
    userId,
    status,
    controller,
    heartbeat: null as unknown as ReturnType<typeof setInterval>,
    lockClient,
    lockReleased: false,
    lockErrorListener: null as unknown as (error: Error) => void
  } satisfies ConversationRunHandle;
  handle.lockErrorListener = (error) => {
    console.error('[chat-run] advisory lock connection failed', error);
    abortLocalHandle(handle);
    void releaseConversationLock(handle, true);
  };
  lockClient.on('error', handle.lockErrorListener);
  handle.heartbeat = setInterval(() => void renewConversationRun(handle), RUN_HEARTBEAT_MS);
  handle.heartbeat.unref?.();
  runs.set(conversationId, handle);
  return handle;
}

export function beginConversationRun(conversationId: string, userId: string) {
  return acquireConversationLease(conversationId, userId, 'running');
}

export function beginConversationMutation(conversationId: string, userId: string) {
  return acquireConversationLease(conversationId, userId, 'mutation');
}

async function renewConversationRun(handle: ConversationRunHandle) {
  if (handle.controller.signal.aborted) return;
  try {
    const result = await handle.lockClient.query(
      `UPDATE chat_conversation_runs
       SET heartbeat_at = NOW(), expires_at = NOW() + INTERVAL '15 seconds'
       WHERE conversation_id = $1 AND run_id = $2 AND status = $3`,
      [handle.conversationId, handle.runId, handle.status]
    );
    if ((result.rowCount ?? 0) === 0) abortLocalHandle(handle);
  } catch (error) {
    console.error('[chat-run] heartbeat failed', error);
    abortLocalHandle(handle);
    await releaseConversationLock(handle, true);
  }
}

function abortLocalHandle(handle: ConversationRunHandle) {
  if (!handle.controller.signal.aborted) handle.controller.abort();
  clearInterval(handle.heartbeat);
}

async function releaseConversationLock(handle: ConversationRunHandle, destroy = false) {
  if (handle.lockReleased) return;
  handle.lockReleased = true;
  handle.lockClient.removeListener('error', handle.lockErrorListener);
  if (!destroy) {
    try {
      await handle.lockClient.query(
        `SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`,
        ['chat_conversation_run', handle.conversationId]
      );
    } catch (error) {
      console.error('[chat-run] failed to release advisory lock', error);
      destroy = true;
    }
  }
  handle.lockClient.release(destroy);
}

export async function abortConversationRun(conversationId: string, userId: string) {
  const local = runs.get(conversationId);
  const localMatches = local?.status === 'running' && local.userId === userId;
  const result = await run(
    `UPDATE chat_conversation_runs
     SET status = 'stop_requested', heartbeat_at = NOW(), expires_at = NOW() + INTERVAL '15 seconds'
     WHERE conversation_id = ? AND user_id = ? AND status = 'running'`,
    [conversationId, userId]
  );
  if (localMatches) abortLocalHandle(local);
  return result.changes > 0;
}

export async function finishConversationRun(handle: ConversationRunHandle) {
  clearInterval(handle.heartbeat);
  if (runs.get(handle.conversationId) === handle) runs.delete(handle.conversationId);
  if (handle.lockReleased) {
    const result = await run(
      'DELETE FROM chat_conversation_runs WHERE conversation_id = ? AND run_id = ?',
      [handle.conversationId, handle.runId]
    );
    return result.changes > 0;
  }
  let removed = false;
  try {
    const result = await handle.lockClient.query(
      'DELETE FROM chat_conversation_runs WHERE conversation_id = $1 AND run_id = $2',
      [handle.conversationId, handle.runId]
    );
    removed = (result.rowCount ?? 0) > 0;
  } finally {
    await releaseConversationLock(handle);
  }
  return removed;
}

export async function isConversationRunActive(conversationId: string, userId?: string) {
  if (!conversationId) return false;
  const row = await get<{ ok: number }>(
    `SELECT 1 AS ok
     FROM chat_conversation_runs
     WHERE conversation_id = ?
       ${userId ? 'AND user_id = ?' : ''}
       AND status IN ('running', 'stop_requested')
       AND expires_at > NOW()
     LIMIT 1`,
    userId ? [conversationId, userId] : [conversationId]
  );
  return Boolean(row);
}

export async function listActiveConversationRunIds() {
  const rows = await all<{ conversation_id: string }>(
    `SELECT conversation_id
     FROM chat_conversation_runs
     WHERE status IN ('running', 'stop_requested') AND expires_at > NOW()`
  );
  return rows.map((row) => row.conversation_id);
}

export async function resetConversationRunsForTests(conversationIds: string[]) {
  for (const conversationId of conversationIds) {
    const local = runs.get(conversationId);
    if (local) {
      abortLocalHandle(local);
      await releaseConversationLock(local).catch(() => undefined);
    }
    runs.delete(conversationId);
  }
  if (!conversationIds.length) return;
  const placeholders = conversationIds.map(() => '?').join(', ');
  await run(`DELETE FROM chat_conversation_runs WHERE conversation_id IN (${placeholders})`, conversationIds);
}
