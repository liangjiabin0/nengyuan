/**
 * 日常扫描导入：快速导入 + 文档级索引（默认推荐策略）
 */
import { startDataImport } from '../src/lib/data-import';
import { getImportJobState } from '../src/lib/import-state';
import { getDataRootDir } from '../src/lib/config';

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const root = process.argv[2] || getDataRootDir();
  console.log('dataRoot=', root);
  const started = startDataImport(root, {
    fast: true,
    skipCaj: true,
    fullRebuild: false,
    indexChunks: false
  });
  if (!started.started) {
    console.error('未能启动：', started.state?.status, started.state?.message);
    process.exit(1);
  }

  for (;;) {
    const state = getImportJobState();
    const progress = state.progress ? `${state.progress.current}/${state.progress.total}` : '';
    console.log(`[${state.status}] ${state.phase} ${progress} ${state.message || ''}`);
    if (state.status === 'done' || state.status === 'error') {
      const result = state.result as Record<string, any> | undefined;
      console.log(
        JSON.stringify(
          {
            status: state.status,
            indexMode: result?.indexMode,
            papers: result?.papers && {
              files: result.papers.files,
              imported: result.papers.imported,
              failed: result.papers.failed,
              skipped: result.papers.skipped,
              changed: result.papers.changedKeys?.length
            },
            patents: result?.patents && {
              files: result.patents.files,
              imported: result.patents.imported,
              failed: result.patents.failed
            },
            mentors: result?.mentors && {
              files: result.mentors.files,
              imported: result.mentors.imported,
              failed: result.mentors.failed,
              skipped: result.mentors.skipped,
              changed: result.mentors.changedKeys?.length
            },
            index: result?.index,
            error: state.error
          },
          null,
          2
        )
      );
      process.exit(state.status === 'done' ? 0 : 1);
    }
    await sleep(3000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
