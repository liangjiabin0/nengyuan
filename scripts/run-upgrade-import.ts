/**
 * 升级路线图阶段2：磁盘资料导入（默认 SKIP_CAJ_CONVERT=1）
 */
import { startDataImport } from '../src/lib/data-import';
import { getImportJobState } from '../src/lib/import-state';
import { getDataRootDir } from '../src/lib/config';

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  process.env.SKIP_CAJ_CONVERT = process.env.SKIP_CAJ_CONVERT ?? '1';
  const root = process.argv[2] || getDataRootDir();
  console.log('dataRoot=', root);
  console.log('fast import defaults applied by startDataImport');

  const started = startDataImport(root, {
    fast: true,
    skipCaj: process.env.SKIP_CAJ_CONVERT === '1',
    fullRebuild: process.env.FULL_REBUILD_INDEX === '1',
    indexChunks: process.env.INDEX_CHUNKS === '1'
  });
  if (!started.started) {
    console.error('未能启动导入：', started.state);
    process.exit(1);
  }

  for (;;) {
    const state = getImportJobState();
    const progress = state.progress ? `${state.progress.current}/${state.progress.total}` : '';
    console.log(`[${state.status}] ${state.phase} ${progress} ${state.message || ''}`);
    if (state.status === 'done' || state.status === 'error') {
      const summary = {
        status: state.status,
        phase: state.phase,
        message: state.message,
        papers: state.result?.papers && {
          files: state.result.papers.files,
          imported: state.result.papers.imported,
          failed: state.result.papers.failed,
          skipped: state.result.papers.skipped
        },
        patents: state.result?.patents && {
          files: state.result.patents.files,
          imported: state.result.patents.imported,
          failed: state.result.patents.failed
        },
        mentors: state.result?.mentors && {
          files: state.result.mentors.files,
          imported: state.result.mentors.imported,
          failed: state.result.mentors.failed,
          skipped: state.result.mentors.skipped
        }
      };
      console.log(JSON.stringify(summary, null, 2));
      process.exit(state.status === 'done' ? 0 : 1);
    }
    await sleep(5000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
