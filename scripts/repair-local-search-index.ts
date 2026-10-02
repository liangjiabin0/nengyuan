import fs from 'node:fs';
import { loadProjectEnv } from '../src/lib/load-env';
loadProjectEnv();

async function main() {
  const { indexDocumentsFast } = await import('../src/lib/doc-index');
  const { persistDbSummary } = await import('../src/lib/db');
  const { updateImportJobState } = await import('../src/lib/import-state');
  const result = await indexDocumentsFast();
  const summary = await persistDbSummary({ includeSlowCounts: true });
  const reportPath = 'storage/data-import-pdf.json';
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.indexRepair = { at: new Date().toISOString(), result, reason: 'Legacy 32-bit search record ID collision' };
  report.summary = summary;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  updateImportJobState({ status: 'done', phase: 'done', message: '资料导入与索引校验修复完成', result: summary });
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
