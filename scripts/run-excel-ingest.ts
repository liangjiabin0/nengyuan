import { ingestExcelAndCsv } from '../src/lib/excel-ingest';

async function main() {
  const result = await ingestExcelAndCsv({ rebuildIndex: false });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
