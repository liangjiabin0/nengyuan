import { all } from '../src/lib/db';

async function main() {
const phrases = ['157', '95', 'MW', '上升至', '198', '44', '是哪个论文', '157.95', '198.44'];
const paperKey = await all<{ title: string; body: string }>(
  `SELECT title, body FROM search_records WHERE title LIKE '%郑培钧%'`
);

console.log('郑培钧记录数', paperKey.length);
for (const row of paperKey) {
  console.log('\n标题', row.title);
  for (const p of phrases) {
    if (row.body.includes(p)) console.log('  命中短语:', p);
  }
}

const li = await all<{ title: string; record_id: string }>(
  `SELECT sr.title, sr.record_id FROM search_records sr
   JOIN paper_chunks pc ON sr.source_key = pc.chunk_key
   WHERE pc.text LIKE '%157.95%' LIMIT 3`
);
console.log('\n含157.95的检索记录:', li);

for (const p of ['157', '95', '198', '44']) {
  const c = await all<{ c: number }>(
    `SELECT COUNT(*) as c FROM search_records WHERE source_type IN ('paper','paper_chunk') AND body LIKE ?`,
    [`%${p}%`]
  );
  console.log(`body含 ${p} 的记录数:`, c[0]?.c);
}
}

main().catch(console.error);
