/**
 * 从外部数据目录只读导入（不修改源盘文件）
 * 用法: npx tsx scripts/run-import-readonly.ts "F:\研究院数据\DATA"
 */
import { awaitDataImport } from '../src/lib/data-import';

const rootDir = process.argv[2] || 'F:\\研究院数据\\DATA';

async function main() {
  process.env.DATA_IMPORT_READONLY = '1';
  console.log('[readonly-import] 源目录（只读）:', rootDir);
  console.log('[readonly-import] 开始时间:', new Date().toISOString());

  const { result, state } = await awaitDataImport(rootDir);

  console.log('[readonly-import] 结束时间:', new Date().toISOString());
  console.log('status:', state.status, state.message);
  if (state.error) console.error('error:', state.error);
  if (result) {
    console.log('papers:', result.papers.imported, 'failed', result.papers.failed);
    console.log('patents:', result.patents.imported, 'failed', result.patents.failed);
    console.log('mentors:', result.mentors.imported, 'failed', result.mentors.failed);
    console.log('index:', result.index);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
