import { loadProjectEnv } from '../src/lib/load-env';

loadProjectEnv();

async function main() {
  const { exportKnowledgeCorpus } = await import('../src/lib/corpus/export');
  const result = await exportKnowledgeCorpus();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
