/**
 * 期刊追踪：手动跑一次抓取。
 *   npx tsx scripts/journal-watch.ts            # 从上次成功运行之后抓
 *   npx tsx scripts/journal-watch.ts --days 30  # 往前补抓 30 天
 */
import { loadProjectEnv } from '../src/lib/load-env';

async function main() {
  loadProjectEnv();
  const { ensureDb } = await import('../src/lib/db');
  const { runJournalWatch } = await import('../src/lib/journal-watch/run');
  await ensureDb();
  const daysIndex = process.argv.indexOf('--days');
  const backfillDays = daysIndex >= 0 ? Number(process.argv[daysIndex + 1]) || undefined : undefined;
  const summary = await runJournalWatch({
    trigger: 'cli',
    backfillDays,
    onProgress: (progress) => console.log('[journal-watch]', JSON.stringify(progress))
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((error) => {
  console.error('[journal-watch] 失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
