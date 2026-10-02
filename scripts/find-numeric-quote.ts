import Database from 'better-sqlite3';
import { config } from '../src/lib/config';

const needles = ['157.95', '198.44', '157', '198'];
const db = new Database(config.databasePath, { readonly: true });

for (const needle of needles) {
  console.log(`\n=== 搜索 "${needle}" ===`);
  const chunks = db.prepare(`
    SELECT p.title, c.section, substr(c.text, 1, 200) as preview
    FROM paper_chunks c
    JOIN paper_documents p ON p.paper_key = c.paper_key
    WHERE c.chunk_role = 'child' AND c.text LIKE ?
    LIMIT 8
  `).all(`%${needle}%`) as Array<{ title: string; section: string; preview: string }>;
  console.log('chunk 命中数:', chunks.length);
  for (const row of chunks) {
    console.log('-', row.title);
    console.log(' ', row.preview.replace(/\s+/g, ' '));
  }

  const papers = db.prepare(`
    SELECT title FROM paper_documents
    WHERE title LIKE ? OR abstract LIKE ?
    LIMIT 5
  `).all(`%${needle}%`, `%${needle}%`);
  console.log('paper 元数据命中:', papers);
}

const wrongPaper = db.prepare(`
  SELECT title FROM paper_documents WHERE title LIKE '%郑培钧%' OR title LIKE '%氢燃料电池%'
`).all();
console.log('\n系统指向的论文:', wrongPaper);

const wrongHits = db.prepare(`
  SELECT substr(text, 1, 400) as t FROM paper_chunks
  WHERE paper_key IN (SELECT paper_key FROM paper_documents WHERE title LIKE '%郑培钧%')
  AND (text LIKE '%157.95%' OR text LIKE '%198.44%')
`).all();
console.log('郑培钧论文是否含目标数值:', wrongHits.length, wrongHits);

const correct = db.prepare(`
  SELECT substr(text, 1, 900) AS t FROM paper_chunks
  WHERE text LIKE '%157.95%' AND text LIKE '%198.44%'
`).all() as Array<{ t: string }>;
console.log('\n正确原文片段:');
for (const row of correct) console.log(row.t.replace(/\s+/g, ' '));

const zhengBody = db.prepare(`
  SELECT body FROM search_records WHERE title LIKE '%郑培钧%' AND source_type = 'paper'
`).get() as { body?: string } | undefined;
console.log('\n郑培钧 paper 索引 body 长度:', zhengBody?.body?.length);
console.log('含 157.95?', zhengBody?.body?.includes('157.95'));
console.log('含 157?', zhengBody?.body?.includes('157'));
console.log('含 MW?', zhengBody?.body?.includes('MW'));

const quote = db.prepare(`
  SELECT text FROM paper_chunks WHERE text LIKE '%157.95%' AND text LIKE '%198.44%'
`).all() as Array<{ text: string }>;
for (const row of quote) {
  const t = row.text.replace(/\s+/g, ' ');
  const idx = t.indexOf('157.95');
  if (idx >= 0) console.log('\n精确上下文:', t.slice(Math.max(0, idx - 100), idx + 150));
}

db.close();
