import { globalSearch } from '../src/lib/global-search';

async function main() {
  const r = await globalSearch({ query: '巨云涛', limit: 8 });
  console.log('top 8:');
  for (const item of r.results.slice(0, 8)) {
    console.log(`- [${item.sourceType}] ${item.title?.slice(0, 60)} score=${Math.round(item.score)}`);
  }
  const papers = r.results.filter((x) => x.sourceType === 'paper' || x.sourceType === 'paper_chunk');
  console.log('\npapers count:', papers.length);
  for (const item of papers.slice(0, 5)) {
    console.log(`  paper: ${item.title?.slice(0, 70)}`);
  }
}
main();
