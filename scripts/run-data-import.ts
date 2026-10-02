import { awaitDataImport } from '../src/lib/data-import';

async function main() {
  const rootDir = process.argv[2] || 'E:\\研究院数据\\DATA';
  console.log('[start]', new Date().toISOString(), rootDir);
  const { result, state } = await awaitDataImport(rootDir);
  console.log('[done]', new Date().toISOString());
  console.log('status', state.status, state.message);
  if (state.error) console.error('error', state.error);
  if (result) {
    console.log('caj converted papers', result.conversion.papers.converted, 'failed', result.conversion.papers.failed);
    console.log('papers imported', result.papers.imported, 'failed', result.papers.failed);
    console.log('patents imported', result.patents.imported);
    console.log('mentors imported', result.mentors.imported, 'failed', result.mentors.failed);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
