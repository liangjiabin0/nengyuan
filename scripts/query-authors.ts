import { get } from '../src/lib/db';

async function main() {
  const chunk = await get<{ text: string }>(
    `SELECT text FROM paper_chunks c
     JOIN paper_documents p ON p.paper_key = c.paper_key
     WHERE p.title LIKE '%新型配电系统分布式资源%'
     ORDER BY c.chunk_index LIMIT 1`
  );
  const lines = chunk!.text.split('\n');
  for (const line of lines) {
    if (line.includes('潘美琪')) {
      console.log('line:', JSON.stringify(line));
      console.log('test:', /[\u4e00-\u9fa5]{2,4}\s*\d+[，,、]/.test(line.trim()));
      const names = [...line.trim().matchAll(/([\u4e00-\u9fa5]{2,4})\s*\d+/g)].map((m) => m[1]);
      console.log('names:', names);
      for (const ch of line.trim()) {
        if (/\d|，|,/.test(ch)) console.log('char', ch, ch.charCodeAt(0));
      }
    }
  }
}
main();
