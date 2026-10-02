import assert from 'node:assert/strict';
import { horizontalSearch } from '../src/lib/horizontal-search';

async function main() {
  const title = '国产 6.5 kV/400 A SiC MOSFET 模块研制及电气特性研究';
  const started = Date.now();
  const result = await horizontalSearch({
    query: title,
    domain: 'paper',
    limit: 24
  });
  const elapsed = Date.now() - started;

  assert.ok(result.results.length > 0, '精确题名应命中论文');
  assert.ok(
    result.results.some((item) =>
      String(item.title || '').replace(/[\s_]/g, '').includes('国产6.5kV400ASiCMOSFET模块研制及电气特性研究')
    ),
    '结果应包含目标题名'
  );
  assert.ok(elapsed < 5_000, `精确题名快路径耗时过长：${elapsed}ms`);

  console.log(`exact-title search tests passed (${elapsed}ms)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
