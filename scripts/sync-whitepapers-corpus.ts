import { getDb } from '../src/lib/db';
import { syncPaperDocumentsToCorpus } from '../src/lib/corpus/export';

const result = syncPaperDocumentsToCorpus(getDb(), { keyPrefix: 'whitepaper:' });
console.log(JSON.stringify(result, null, 2));
