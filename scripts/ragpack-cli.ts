import { exportRagPack } from '../src/lib/ragpack/export';
import { importRagPack } from '../src/lib/ragpack/import';

const cmd = process.argv[2];
const arg = process.argv[3];

async function main() {
  if (cmd === 'export') {
    const result = await exportRagPack(arg);
    console.log('exported', result.outPath, `${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
    return;
  }
  if (cmd === 'import') {
    if (!arg) throw new Error('用法: npx tsx scripts/ragpack-cli.ts import <file.ragpack>');
    const result = await importRagPack(arg);
    console.log('imported', result.bundleRoot, result);
    return;
  }
  throw new Error('用法: export [outPath] | import <file.ragpack>');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
