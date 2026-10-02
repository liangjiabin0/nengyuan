import { all, run, withTransaction } from '@/lib/db';
import { CHAT_ATTACHMENT_MAX_BIND_FILES, getChatAttachment } from '@/lib/chat-attachments';
import { lockConversationQueueMutation } from '@/lib/chat-run-registry';
import type { ChatQueuedTurn } from '@/lib/chat-send-queue';

export const CHAT_SEND_QUEUE_MAX_ITEMS = 40;
export const CHAT_SEND_QUEUE_MAX_QUESTION_CHARS = 20_000;

type QueueRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  question: string;
  attachment_ids_json: string;
  user_message_id: string | null;
  assistant_message_id: string | null;
  sort_index: number;
  created_at: string;
};

const QUEUE_SELECT = `q.id, q.user_id, q.conversation_id, q.question, q.attachment_ids_json, q.user_message_id, q.assistant_message_id, q.sort_index, q.created_at`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let queueTableReady: Promise<void> | null = null;

function ensureQueueTable() {
  if (!queueTableReady) {
    queueTableReady = (async () => {
      await run(`
        CREATE TABLE IF NOT EXISTS chat_send_queue (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          question TEXT NOT NULL DEFAULT '',
          attachment_ids_json TEXT NOT NULL DEFAULT '[]',
          user_message_id TEXT,
          assistant_message_id TEXT,
          sort_index INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
        )
      `);
      await run('ALTER TABLE chat_send_queue ADD COLUMN IF NOT EXISTS user_message_id TEXT');
      await run('ALTER TABLE chat_send_queue ADD COLUMN IF NOT EXISTS assistant_message_id TEXT');
      await run('CREATE INDEX IF NOT EXISTS idx_chat_send_queue_user ON chat_send_queue (user_id, conversation_id, sort_index, created_at)');
      await run('CREATE INDEX IF NOT EXISTS idx_chat_send_queue_conversation ON chat_send_queue (conversation_id)');
    })().catch((error) => {
      queueTableReady = null;
      throw error;
    });
  }
  return queueTableReady;
}

function parseAttachmentIds(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((item) => String(item || '').trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

async function ensureQueueMessageIds(row: QueueRow) {
  if (UUID_RE.test(row.user_message_id || '') && UUID_RE.test(row.assistant_message_id || '')) {
    return row;
  }
  const rows = await all<QueueRow>(
    `UPDATE chat_send_queue
     SET user_message_id = COALESCE(user_message_id, ?),
         assistant_message_id = COALESCE(assistant_message_id, ?)
     WHERE id = ? AND user_id = ? AND conversation_id = ?
     RETURNING id, user_id, conversation_id, question, attachment_ids_json,
               user_message_id, assistant_message_id, sort_index, created_at`,
    [
      crypto.randomUUID(),
      crypto.randomUUID(),
      row.id,
      row.user_id,
      row.conversation_id
    ]
  );
  return rows[0] || row;
}

async function toQueuedTurn(input: QueueRow): Promise<ChatQueuedTurn> {
  const row = await ensureQueueMessageIds(input);
  const ids = parseAttachmentIds(row.attachment_ids_json);
  const attachments = (
    await Promise.all(ids.map((attachmentId) => getChatAttachment(row.conversation_id, attachmentId)))
  ).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return {
    id: row.id,
    conversationId: row.conversation_id,
    question: row.question,
    attachments,
    userMessageId: row.user_message_id || crypto.randomUUID(),
    assistantMessageId: row.assistant_message_id || crypto.randomUUID(),
    createdAt: row.created_at
  };
}

export async function listUserSendQueue(userId: string, conversationId?: string) {
  await ensureQueueTable();
  const rows = conversationId
    ? await all<QueueRow>(
        `SELECT ${QUEUE_SELECT}
         FROM chat_send_queue q
         INNER JOIN chat_conversations c ON c.id = q.conversation_id
         WHERE q.user_id = ?
           AND q.conversation_id = ?
           AND c.user_id = ?
         ORDER BY q.sort_index ASC, q.created_at ASC, q.id ASC`,
        [userId, conversationId, userId]
      )
    : await all<QueueRow>(
        `SELECT ${QUEUE_SELECT}
         FROM chat_send_queue q
         INNER JOIN chat_conversations c ON c.id = q.conversation_id
         WHERE q.user_id = ?
           AND c.user_id = ?
         ORDER BY q.sort_index ASC, q.created_at ASC, q.id ASC`,
        [userId, userId]
      );
  return Promise.all(rows.map((row) => toQueuedTurn(row)));
}

export async function enqueueUserSendTurn(input: {
  id?: string;
  userId: string;
  conversationId: string;
  question: string;
  attachmentIds?: string[];
}) {
  await ensureQueueTable();
  const question = String(input.question || '').slice(0, CHAT_SEND_QUEUE_MAX_QUESTION_CHARS);
  const attachmentIds = [...new Set((input.attachmentIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (attachmentIds.length > CHAT_ATTACHMENT_MAX_BIND_FILES) {
    return {
      ok: false as const,
      status: 413,
      error: `每条消息最多附加 ${CHAT_ATTACHMENT_MAX_BIND_FILES} 个文件。`
    };
  }
  if (!question.trim() && !attachmentIds.length) {
    return { ok: false as const, status: 400, error: '排队内容不能为空。' };
  }

  const requestedId = String(input.id || '').trim();
  const id = UUID_RE.test(requestedId) ? requestedId : crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const attachmentIdsJson = JSON.stringify(attachmentIds);
  const createdAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const result = await withTransaction(async (database) => {
    const mutationBeforeLock = await database.prepare(
      `SELECT 1 AS ok
       FROM chat_conversation_runs
       WHERE conversation_id = ?
         AND status = 'mutation'
         AND expires_at > NOW()
       LIMIT 1`
    ).get<{ ok: number }>(input.conversationId);
    if (mutationBeforeLock) {
      return { ok: false as const, status: 409, error: '会话正在修改，请稍后重试。' };
    }

    // Keep this order aligned with mutation leases: conversation first, then user.
    // The conversation lock covers attachment validation through queue insertion.
    await lockConversationQueueMutation(database, input.conversationId);
    await database.prepare(
      `SELECT pg_advisory_xact_lock(hashtext('chat_send_queue'), hashtext(?)) AS locked`
    ).get(input.userId);

    const conversation = await database.prepare(
      `SELECT id, user_id
       FROM chat_conversations
       WHERE id = ?
       LIMIT 1
       FOR KEY SHARE`
    ).get<{ id: string; user_id: string | null }>(input.conversationId);
    if (!conversation) return { ok: false as const, status: 404, error: '会话不存在。' };
    if (conversation.user_id !== input.userId) {
      return { ok: false as const, status: 403, error: '无权访问该会话。' };
    }
    const activeMutation = await database.prepare(
      `SELECT 1 AS ok
       FROM chat_conversation_runs
       WHERE conversation_id = ?
         AND status = 'mutation'
         AND expires_at > NOW()
       LIMIT 1`
    ).get<{ ok: number }>(input.conversationId);
    if (activeMutation) {
      return { ok: false as const, status: 409, error: '会话正在修改，请稍后重试。' };
    }
    const existing = await database.prepare(
      `SELECT ${QUEUE_SELECT}
       FROM chat_send_queue q
       WHERE q.id = ?
       LIMIT 1`
    ).get<QueueRow>(id);
    if (existing) {
      const sameRequest = existing.user_id === input.userId
        && existing.conversation_id === input.conversationId
        && existing.question === question
        && existing.attachment_ids_json === attachmentIdsJson;
      if (sameRequest) return { ok: true as const, row: existing };
      return { ok: false as const, status: 409, error: '排队标识已存在。' };
    }

    if (attachmentIds.length) {
      const placeholders = attachmentIds.map(() => '?').join(', ');
      const attachmentCount = await database.prepare(
        `SELECT COUNT(*) AS total
         FROM chat_attachments
         WHERE conversation_id = ?
           AND parse_status = 'ready'
           AND id IN (${placeholders})`
      ).get<{ total: number }>(input.conversationId, ...attachmentIds);
      if (Number(attachmentCount?.total || 0) !== attachmentIds.length) {
        return { ok: false as const, status: 403, error: '部分附件不存在、尚未解析完成或不属于当前会话。' };
      }
    }

    const countRow = await database.prepare(
      'SELECT COUNT(*) AS total FROM chat_send_queue WHERE user_id = ?'
    ).get<{ total: number }>(input.userId);
    if (Number(countRow?.total || 0) >= CHAT_SEND_QUEUE_MAX_ITEMS) {
      return { ok: false as const, status: 400, error: `每位用户最多排队 ${CHAT_SEND_QUEUE_MAX_ITEMS} 条。` };
    }

    const nextIndexRow = await database.prepare(
      `SELECT COALESCE(MAX(sort_index), 0) + 1 AS next
       FROM chat_send_queue
       WHERE user_id = ? AND conversation_id = ?`
    ).get<{ next: number }>(input.userId, input.conversationId);
    const rows = await database.prepare(
      `INSERT INTO chat_send_queue
         (id, user_id, conversation_id, question, attachment_ids_json, user_message_id, assistant_message_id, sort_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, user_id, conversation_id, question, attachment_ids_json,
                 user_message_id, assistant_message_id, sort_index, created_at`
    ).all<QueueRow>(
      id,
      input.userId,
      input.conversationId,
      question,
      attachmentIdsJson,
      userMessageId,
      assistantMessageId,
      Number(nextIndexRow?.next || 1),
      createdAt
    );
    const row = rows[0];
    if (!row) return { ok: false as const, status: 409, error: '排队标识已存在。' };
    return { ok: true as const, row };
  });
  if (!result.ok) return result;
  return { ok: true as const, item: await toQueuedTurn(result.row) };
}

export async function deleteUserSendTurn(userId: string, id: string) {
  await ensureQueueTable();
  const rows = await all<QueueRow>(
    `DELETE FROM chat_send_queue q
     USING chat_conversations c
     WHERE q.id = ?
       AND q.user_id = ?
       AND c.id = q.conversation_id
       AND c.user_id = ?
     RETURNING ${QUEUE_SELECT}`,
    [id, userId, userId]
  );
  const row = rows[0];
  if (!row) return null;
  return toQueuedTurn(row);
}

export async function isAttachmentReferencedBySendQueue(
  userId: string,
  conversationId: string,
  attachmentId: string
) {
  await ensureQueueTable();
  const rows = await all<Pick<QueueRow, 'attachment_ids_json'>>(
    `SELECT q.attachment_ids_json
     FROM chat_send_queue q
     INNER JOIN chat_conversations c ON c.id = q.conversation_id
     WHERE q.user_id = ? AND q.conversation_id = ? AND c.user_id = ?`,
    [userId, conversationId, userId]
  );
  return rows.some((row) => parseAttachmentIds(row.attachment_ids_json).includes(attachmentId));
}

export async function getUserSendTurn(userId: string, conversationId: string, id: string) {
  await ensureQueueTable();
  const rows = await all<QueueRow>(
    `SELECT ${QUEUE_SELECT}
     FROM chat_send_queue q
     INNER JOIN chat_conversations c ON c.id = q.conversation_id
     WHERE q.id = ?
       AND q.user_id = ?
       AND q.conversation_id = ?
       AND c.user_id = ?
     LIMIT 1`,
    [id, userId, conversationId, userId]
  );
  return rows[0] ? toQueuedTurn(rows[0]) : null;
}

export async function peekNextUserSendTurn(userId: string, conversationId: string) {
  await ensureQueueTable();
  const rows = await all<QueueRow>(
    `SELECT ${QUEUE_SELECT}
     FROM chat_send_queue q
     INNER JOIN chat_conversations c ON c.id = q.conversation_id
     WHERE q.user_id = ?
       AND q.conversation_id = ?
       AND c.user_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM chat_conversation_runs r
         WHERE r.conversation_id = q.conversation_id
           AND r.expires_at > NOW()
       )
     ORDER BY q.sort_index ASC, q.created_at ASC, q.id ASC
     LIMIT 1`,
    [userId, conversationId, userId]
  );
  return rows[0] ? toQueuedTurn(rows[0]) : null;
}

/**
 * Durably starts a queued turn. The user message, attachment bindings and
 * queue acknowledgement commit together, so a crash can never remove the
 * only durable copy of the user's request.
 */
export async function commitQueuedUserSendTurn(input: {
  userId: string;
  conversationId: string;
  queueItemId: string;
  runId: string;
  kind: 'chat' | 'research-review';
  maxAttachmentFiles: number;
  messageContent: string;
}) {
  await ensureQueueTable();
  const row = await withTransaction(async (database) => {
    const activeRun = await database.prepare(
      `SELECT run_id
       FROM chat_conversation_runs
       WHERE conversation_id = ?
         AND run_id = ?
         AND user_id = ?
         AND status = 'running'
       FOR UPDATE`
    ).get<{ run_id: string }>(input.conversationId, input.runId, input.userId);
    if (!activeRun) throw new Error('当前生成租约已失效，请重试。');

    const conversation = await database.prepare(
      `SELECT id
       FROM chat_conversations
       WHERE id = ? AND user_id = ? AND COALESCE(kind, 'chat') = ?
       FOR KEY SHARE`
    ).get<{ id: string }>(input.conversationId, input.userId, input.kind);
    if (!conversation) throw new Error('会话不存在或无权访问。');

    let queued = await database.prepare(
      `SELECT ${QUEUE_SELECT}
       FROM chat_send_queue q
       WHERE q.id = ? AND q.user_id = ? AND q.conversation_id = ?
       FOR UPDATE`
    ).get<QueueRow>(input.queueItemId, input.userId, input.conversationId);
    if (!queued) throw new Error('排队项已被其它窗口处理，请刷新后重试。');

    if (!UUID_RE.test(queued.user_message_id || '') || !UUID_RE.test(queued.assistant_message_id || '')) {
      queued = (await database.prepare(
        `UPDATE chat_send_queue
         SET user_message_id = COALESCE(user_message_id, ?),
             assistant_message_id = COALESCE(assistant_message_id, ?)
         WHERE id = ? AND user_id = ? AND conversation_id = ?
         RETURNING id, user_id, conversation_id, question, attachment_ids_json,
                   user_message_id, assistant_message_id, sort_index, created_at`
      ).get<QueueRow>(
        crypto.randomUUID(),
        crypto.randomUUID(),
        input.queueItemId,
        input.userId,
        input.conversationId
      )) || queued;
    }
    if (!UUID_RE.test(queued.user_message_id || '') || !UUID_RE.test(queued.assistant_message_id || '')) {
      throw new Error('排队消息标识无效，请移除后重新排队。');
    }

    const existingAssistantMessage = await database.prepare(
      'SELECT conversation_id, role FROM chat_messages WHERE id = ? FOR KEY SHARE'
    ).get<{ conversation_id: string; role: string }>(queued.assistant_message_id);
    if (
      existingAssistantMessage
      && (
        existingAssistantMessage.conversation_id !== input.conversationId
        || existingAssistantMessage.role !== 'assistant'
      )
    ) {
      throw new Error('排队助手消息标识已被其它消息占用。');
    }

    const existingUserMessage = await database.prepare(
      'SELECT conversation_id, role, content FROM chat_messages WHERE id = ? FOR KEY SHARE'
    ).get<{ conversation_id: string; role: string; content: string }>(queued.user_message_id);
    if (
      existingUserMessage
      && (
        existingUserMessage.conversation_id !== input.conversationId
        || existingUserMessage.role !== 'user'
        || existingUserMessage.content !== input.messageContent
      )
    ) {
      throw new Error('排队消息标识已被其它消息占用。');
    }
    if (!existingUserMessage) {
      await database.prepare(
        `INSERT INTO chat_messages
           (id, conversation_id, role, content, sources_json, graph_seed_ids_json, agent_steps_json, created_at)
         VALUES (?, ?, 'user', ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)`
      ).run(queued.user_message_id, input.conversationId, input.messageContent);
    }

    const attachmentIds = parseAttachmentIds(queued.attachment_ids_json);
    if (attachmentIds.length > input.maxAttachmentFiles) {
      throw new Error(`每条消息最多附加 ${input.maxAttachmentFiles} 个文件。`);
    }
    if (attachmentIds.length) {
      const placeholders = attachmentIds.map(() => '?').join(', ');
      const attachments = await database.prepare(
        `SELECT id, message_id
         FROM chat_attachments
         WHERE conversation_id = ?
           AND parse_status = 'ready'
           AND id IN (${placeholders})
         FOR UPDATE`
      ).all<{ id: string; message_id: string | null }>(input.conversationId, ...attachmentIds);
      if (
        attachments.length !== attachmentIds.length
        || attachments.some((attachment) => (
          attachment.message_id && attachment.message_id !== queued.user_message_id
        ))
      ) {
        throw new Error('部分附件不存在、尚未解析完成或已绑定到其它消息。');
      }
      await database.prepare(
        `UPDATE chat_attachments
         SET message_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE conversation_id = ?
           AND id IN (${placeholders})
           AND (message_id IS NULL OR message_id = ?)`
      ).run(queued.user_message_id, input.conversationId, ...attachmentIds, queued.user_message_id);
      const insertBinding = database.prepare(
        `INSERT INTO chat_message_attachments (conversation_id, message_id, attachment_id)
         VALUES (?, ?, ?)
         ON CONFLICT (message_id, attachment_id) DO NOTHING`
      );
      for (const attachmentId of attachmentIds) {
        await insertBinding.run(input.conversationId, queued.user_message_id, attachmentId);
      }
    }

    const deleted = await database.prepare(
      `DELETE FROM chat_send_queue
       WHERE id = ? AND user_id = ? AND conversation_id = ?`
    ).run(input.queueItemId, input.userId, input.conversationId);
    if (deleted.changes !== 1) throw new Error('排队项状态刚刚发生变化，请重试。');
    await database.prepare(
      'UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
    ).run(input.conversationId, input.userId);
    return queued;
  });
  return toQueuedTurn(row);
}

export async function consumeUserSendTurn(userId: string, conversationId: string, id: string) {
  await ensureQueueTable();
  const rows = await all<QueueRow>(
    `DELETE FROM chat_send_queue q
     USING chat_conversations c
     WHERE q.id = ?
       AND q.user_id = ?
       AND q.conversation_id = ?
       AND c.id = q.conversation_id
       AND c.user_id = ?
     RETURNING ${QUEUE_SELECT}`,
    [id, userId, conversationId, userId]
  );
  return rows[0] ? toQueuedTurn(rows[0]) : null;
}

export async function takeNextUserSendTurn(userId: string, conversationId: string) {
  await ensureQueueTable();
  const rows = await all<QueueRow>(
    `WITH next_item AS (
       SELECT q.id
       FROM chat_send_queue q
       INNER JOIN chat_conversations c ON c.id = q.conversation_id
       WHERE q.user_id = ?
         AND q.conversation_id = ?
         AND c.user_id = ?
       ORDER BY q.sort_index ASC, q.created_at ASC, q.id ASC
       LIMIT 1
       FOR UPDATE OF q SKIP LOCKED
     )
     DELETE FROM chat_send_queue q
     USING next_item
     WHERE q.id = next_item.id
       AND q.user_id = ?
       AND q.conversation_id = ?
     RETURNING ${QUEUE_SELECT}`,
    [userId, conversationId, userId, userId, conversationId]
  );
  const row = rows[0];
  return row ? toQueuedTurn(row) : null;
}

export async function deleteSendQueueForConversation(conversationId: string) {
  await ensureQueueTable();
  await run('DELETE FROM chat_send_queue WHERE conversation_id = ?', [conversationId]);
}
