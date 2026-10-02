import { getDb } from '../src/lib/db.ts';

const db = getDb();
const rows = db
  .prepare(
    `SELECT id, title, user_id, kind, updated_at
     FROM chat_conversations
     WHERE kind = 'research-review'
     ORDER BY updated_at DESC
     LIMIT 10`
  )
  .all();
console.log(JSON.stringify(rows, null, 2));

for (const row of rows) {
  const att = db
    .prepare(
      `SELECT COUNT(*) AS n FROM chat_attachments
       WHERE conversation_id = ? AND parse_status = 'ready'`
    )
    .get(row.id);
  const msgs = db
    .prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id = ?`)
    .get(row.id);
  console.log(row.id, 'ready_att=', att?.n, 'msgs=', msgs?.n, 'title=', row.title);
}
