import { literalRetrieve, evaluateLiteralCoverage, extractLiteralAnchors } from '../src/lib/literal-retrieval';
import { langchainRetrieve } from '../src/lib/langchain/pipeline';

const query = '157.95 MW 上升至 198.44 MW是哪个论文';
const expected = '李兆泽';
const wrong = '郑培钧';

async function main() {
  const anchors = extractLiteralAnchors(query);
  console.log('锚点:', anchors.map((a) => a.text).join(', '));

  const literal = await literalRetrieve(query, 8);
  console.log('\n字面量检索 Top3:');
  for (const row of literal.slice(0, 3)) {
    const ok = row.title.includes(expected) && !row.title.includes(wrong);
    console.log(row.score, ok ? 'OK' : 'BAD', row.title.slice(0, 70), row.matchReason);
  }

  const coverage = evaluateLiteralCoverage(query, literal);
  console.log('\n共现满足:', coverage.satisfied, '缺失:', coverage.missing);

  const retrieved = await langchainRetrieve(query, '', { limit: 12 });
  const top = retrieved.results[0];
  const topOk = top?.title.includes(expected) && !top?.title.includes(wrong);
  const hasAnchors = retrieved.results.some((r) =>
    `${r.body}${JSON.stringify(r.fields)}`.includes('157.95') && `${r.body}${JSON.stringify(r.fields)}`.includes('198.44')
  );

  console.log('\n融合检索 Top1:', top?.title.slice(0, 70));
  console.log('Top1 正确:', topOk);
  console.log('证据含双锚点:', hasAnchors);
  console.log('置信度:', retrieved.confidence);
  console.log('字面量覆盖:', retrieved.literalCoverage?.satisfied);

  if (!topOk || !hasAnchors || !coverage.satisfied) {
    process.exitCode = 1;
    console.error('\n回归失败');
  } else {
    console.log('\n回归通过');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
