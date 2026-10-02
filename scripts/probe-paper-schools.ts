import { all } from '../src/lib/db';

async function main() {
const papers = await all<{ title: string; authors: string | null; abstract: string | null }>(
  'SELECT title, authors, abstract FROM paper_documents LIMIT 5'
);
console.log('papers sample:', JSON.stringify(papers, null, 2));

const chunks = await all<{ title: string; body: string }>(
  `SELECT title, substr(body, 1, 300) as body FROM search_records
   WHERE source_type = 'paper_chunk' AND body LIKE '%大学%' LIMIT 5`
);
console.log('chunks with 大学:', JSON.stringify(chunks, null, 2));

const orgEntities = await all<{ type: string; name: string; c: number }>(
  `SELECT type, name, COUNT(*) as c FROM entities
   WHERE name LIKE '%大学%' OR name LIKE '%学院%'
   GROUP BY type, name ORDER BY c DESC LIMIT 15`
);
console.log('org entities:', orgEntities);

const affiliations = await all<{ paper_key: string; text: string }>(
  `SELECT paper_key, substr(text, 1, 800) as text FROM paper_chunks
   WHERE chunk_index < 3 AND (text LIKE '%大学%' OR text LIKE '%学院%')
   LIMIT 8`
);
for (const row of affiliations) {
  const matches = [...row.text.matchAll(/[\u4e00-\u9fa5]{2,20}(?:大学|学院)/g)].map((m) => m[0]);
  console.log(row.paper_key, [...new Set(matches)].slice(0, 5));
}
}

main().catch(console.error);
