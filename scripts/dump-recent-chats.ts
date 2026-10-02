import Database from 'better-sqlite3';

const dbPath = 'C:/Users/LMist/Desktop/研究院/storage/ragpack/active/database/rag.sqlite';
const db = new Database(dbPath, { readonly: true });

const convs = db.prepare(`
  SELECT id, title, created_at, updated_at
  FROM chat_conversations
  ORDER BY updated_at DESC
  LIMIT 8
`).all() as Array<{ id: string; title: string; created_at: string; updated_at: string }>;

for (const conv of convs) {
  console.log('\n==========', conv.title, conv.id, '==========');
  const msgs = db.prepare(`
    SELECT role, content, agent_steps_json
    FROM chat_messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(conv.id) as Array<{ role: string; content: string; agent_steps_json: string | null }>;

  for (const [i, msg] of msgs.entries()) {
    console.log(`\n--- [${i + 1}] ${msg.role} ---`);
    console.log(msg.content.slice(0, 2000));
    if (msg.agent_steps_json) {
      try {
        const steps = JSON.parse(msg.agent_steps_json) as Array<{ type: string; tool?: string; content?: string; input?: unknown }>;
        const summary = steps
          .filter((s) => ['thought', 'tool_call', 'observation'].includes(s.type))
          .map((s) => {
            if (s.type === 'tool_call') return `CALL ${s.tool} ${JSON.stringify(s.input)}`;
            if (s.type === 'observation') return `OBS ${s.tool}: ${String(s.content).slice(0, 200)}`;
            return `THOUGHT: ${String(s.content).slice(0, 120)}`;
          });
        console.log('\n[AGENT STEPS]');
        console.log(summary.join('\n'));
      } catch {
        console.log('[agent_steps parse failed]');
      }
    }
  }
}

db.close();
