import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const storage = path.join(root, 'storage');

function remove(target: string) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`已删除: ${path.relative(root, target)}`);
  return true;
}

function removeMatching(dir: string, pattern: RegExp) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (pattern.test(name)) remove(path.join(dir, name));
  }
}

console.log('开始清理，便于打包发送...\n');

remove(path.join(storage, 'rag.sqlite'));
removeMatching(storage, /^rag\.sqlite(\.bak-|-shm|-wal)/);
remove(path.join(storage, 'ragpack'));
remove(path.join(storage, 'exports'));
remove(path.join(storage, 'uploads'));
remove(path.join(storage, 'ragpack-meta.json'));
remove(path.join(storage, 'import-job.json'));
remove(path.join(storage, 'ragpack-job.json'));

for (const name of [
  'eval-agent-multiturn-report.json',
  'eval-multiturn-report.json',
  'rag-benchmark-latest.json',
  'test-10-agent-complex-report.json',
  'test-20-questions-report.json',
  'test-caj-convert.pdf',
  'tmp-20q-test.ts',
  'tmp-ingest-papers.cjs',
  'tmp-validate-papers.ts'
]) {
  remove(path.join(storage, name));
}

fs.mkdirSync(storage, { recursive: true });
fs.writeFileSync(
  path.join(storage, 'db-summary.json'),
  `${JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      stats: {
        files: 0,
        rawRecords: 0,
        projects: 0,
        outputs: 0,
        entities: 0,
        edges: 0
      },
      indexStats: {
        searchRecords: 0,
        searchTerms: 0,
        aliases: 0,
        mentions: 0,
        mergeCandidates: 0
      },
      papers: 0,
      mentors: 0,
      bundleActive: false
    },
    null,
    2
  )}\n`
);
console.log('已重置: storage/db-summary.json');

fs.writeFileSync(
  path.join(storage, 'settings.json'),
  `${JSON.stringify(
    {
      baseUrl: 'https://www.packyapi.com/v1',
      model: 'gpt-5.5',
      apiKey: '',
      embeddingModel: 'text-embedding-3-small',
      semanticSearch: true
    },
    null,
    2
  )}\n`
);
console.log('已重置: storage/settings.json（API Key 已清空）');

remove(path.join(root, 'data'));
remove(path.join(root, '.next'));
remove(path.join(root, 'node_modules'));

console.log('\n清理完成。请单独发送 .ragpack 数据包；接收方 npm install 后导入即可。');
