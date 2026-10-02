import { all } from '../src/lib/db';
import { extractResearchDirections } from '../src/lib/mentor-retrieval';
import { buildChatContexts } from '../src/lib/chat-context';

async function main() {
  const rows = await all<{ chunk_key: string; text: string; title?: string }>(
    `SELECT c.chunk_key, c.text, sr.title
     FROM paper_chunks c
     LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
     WHERE c.text LIKE '%牛泽原%' AND c.chunk_role = 'child'
     LIMIT 5`
  );
  console.log('chunks with 牛泽原:', rows.length);
  for (const row of rows) {
    console.log({
      key: row.chunk_key,
      title: row.title?.slice(0, 80),
      has硕士: /硕士研究生/.test(row.text),
      hasAI电力: /人工智能.{0,12}电力系统/.test(row.text),
      text: row.text.slice(0, 280)
    });
  }

  const history = [
    { role: 'user', content: '研究方向为人工智能与电力系统的还有哪些老师' },
    { role: 'assistant', content: '老师有李嘉媚等' }
  ];
  const ctx = buildChatContexts(history, '那硕士研究生呢');
  const sc = `${ctx.llmContext}\n${ctx.retrievalContext}`;
  console.log('directions:', extractResearchDirections('那硕士研究生呢', sc));

  const bio = await all<{ chunk_key: string; text: string; title?: string }>(
    `SELECT c.chunk_key, c.text, sr.title
     FROM paper_chunks c
     LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
     WHERE c.text LIKE '%1336 牛泽原%' OR (c.text LIKE '%牛泽原%' AND c.text LIKE '%硕士研究生%')
     LIMIT 8`
  );
  console.log('\nbio chunks:', bio.length);
  for (const row of bio) {
    console.log(row.title?.slice(0, 90));
    console.log(row.text.slice(0, 400));
    console.log('---');
  }

  const wu = await all<{ chunk_key: string; text: string; title?: string }>(
    `SELECT c.chunk_key, c.text, sr.title
     FROM paper_chunks c
     LEFT JOIN search_records sr ON sr.source_type = 'paper_chunk' AND sr.source_key = c.chunk_key
     WHERE c.text LIKE '%武宇翔%' AND c.text LIKE '%硕士研究生%'
     LIMIT 3`
  );
  console.log('\n武宇翔 student chunks:', wu.length);

  const niuMaster = await all<{ chunk_key: string; title?: string; text: string }>(
    `SELECT c.chunk_key, c.text, sr.title FROM paper_chunks c
     LEFT JOIN search_records sr ON sr.source_key = c.chunk_key
     WHERE c.text LIKE '%牛泽原%' AND c.text LIKE '%硕士研究生%' LIMIT 5`
  );
  console.log('\n牛泽原+硕士研究生 co-occur:', niuMaster.length);
  for (const row of niuMaster) {
    const idx = row.text.indexOf('硕士研究生');
    console.log(row.title, 'idx=', idx);
    console.log(row.text.slice(Math.max(0, idx - 120), idx + 200));
    console.log('has AI电力 phrase:', /人工智能.{0,16}电力系统/.test(row.text));
  }

  const entities = await all(
    `SELECT e.name, e.type, m.record_id FROM entities e JOIN entity_mentions m ON m.entity_key=e.entity_key WHERE e.name LIKE '%牛泽原%' OR e.name LIKE '%武宇翔%' LIMIT 10`
  );
  console.log('\nentities:', entities);

  const bioHits = await all<{ chunk_key: string; title?: string; text: string }>(
    `SELECT c.chunk_key, c.text, sr.title
     FROM paper_chunks c
     LEFT JOIN search_records sr ON sr.source_key = c.chunk_key
     WHERE c.chunk_role = 'child'
       AND (c.text LIKE '%作者简介%' OR c.text LIKE '%收稿日期%')
       AND c.text LIKE '%硕士研究生%'
       AND c.text LIKE '%人工智能%'
       AND c.text LIKE '%电力系统%'
     LIMIT 30`
  );
  console.log('\nbio SQL hits:', bioHits.length, '牛泽原:', bioHits.filter((r) => r.text.includes('牛泽原')).length);

  const niuRow = await all(
    `SELECT c.chunk_key, c.chunk_role, c.text, sr.title
     FROM paper_chunks c LEFT JOIN search_records sr ON sr.source_key=c.chunk_key
     WHERE c.text LIKE '%牛泽原%' AND c.text LIKE '%硕士研究生%' AND c.text LIKE '%作者简介%' LIMIT 3`
  );
  console.log('niuRow role:', niuRow);

  if (niuMaster[0]) {
    const t = niuMaster[0].text;
    const bioIdx = t.indexOf('作者简介');
    const dateIdx = t.indexOf('收稿日期');
    console.log('\nmatch test:', {
      人工智能: t.includes('人工智能'),
      电力系统: t.includes('电力系统'),
      作者简介: bioIdx,
      收稿日期: dateIdx,
      chunk_key: niuMaster[0].chunk_key
    });
    const withBio = await all(
      `SELECT chunk_key FROM paper_chunks WHERE chunk_key = ? AND text LIKE '%作者简介%'`,
      [niuMaster[0].chunk_key]
    );
    const withDate = await all(
      `SELECT chunk_key FROM paper_chunks WHERE chunk_key = ? AND text LIKE '%收稿日期%'`,
      [niuMaster[0].chunk_key]
    );
    console.log('SQL like 作者简介:', withBio.length, '收稿日期:', withDate.length);
  }
}

main().catch(console.error);
