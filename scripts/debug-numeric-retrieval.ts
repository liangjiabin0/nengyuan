import { searchRecords } from '../src/lib/search-index';
import { langchainRetrieve } from '../src/lib/langchain/pipeline';
const query = '157.95 MW 上升至 198.44 MW是哪个论文';

async function main() {
  // inline phrase extract (copy from search-index)
  const raw = query.normalize('NFKC');
  const phrases = new Set<string>();
  for (const match of raw.matchAll(/[\p{Script=Han}]{2,12}|[A-Za-z][A-Za-z0-9._-]{1,40}|\d{2,}/gu)) {
    phrases.add(match[0].trim());
  }
  console.log('extractRecallPhrases 近似:', [...phrases]);

  const direct = await searchRecords(query, { limit: 10, sourceTypes: ['paper', 'paper_chunk'] });
  console.log('\nsearchRecords top10:');
  for (const r of direct) {
    const hasNum = r.body.includes('157.95') || r.body.includes('198.44');
    console.log(r.score.toFixed(1), hasNum ? '[含数值]' : '[无数值]', r.sourceType, r.title.slice(0, 60));
  }

  const retrieved = await langchainRetrieve(query, '', { limit: 18 });
  console.log('\nlangchainRetrieve top10:');
  for (const r of retrieved.results.slice(0, 10)) {
    const hasNum = (r.body + JSON.stringify(r.fields)).includes('157.95') || (r.body + JSON.stringify(r.fields)).includes('198.44');
    console.log(r.score.toFixed(1), hasNum ? '[含数值]' : '[无数值]', r.sourceType, r.title.slice(0, 60));
  }
}

main().catch(console.error);
