import BetterSqlite3 from 'better-sqlite3';
import { config } from '../src/lib/config';
import fs from 'node:fs';
import path from 'node:path';
import { getParsedFundsDir } from '../src/lib/fund-markdown';
import { getCorpusRoot } from '../src/lib/corpus/schema';

const db = new BetterSqlite3(config.databasePath, { readonly: true, timeout: 5000 });
const result = {
  projects: (db.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c,
  outputs: (db.prepare('SELECT COUNT(*) AS c FROM outputs').get() as { c: number }).c,
  searchProjects: (
    db.prepare("SELECT COUNT(*) AS c FROM search_records WHERE source_type = 'project'").get() as { c: number }
  ).c,
  whitepapers: (
    db.prepare("SELECT COUNT(*) AS c FROM paper_documents WHERE paper_key LIKE 'whitepaper:%'").get() as {
      c: number;
    }
  ).c,
  parsedMd: fs.existsSync(getParsedFundsDir())
    ? fs.readdirSync(getParsedFundsDir()).filter((f) => f.endsWith('.md')).length
    : 0,
  corpusProjects: fs.existsSync(path.join(getCorpusRoot(), 'projects'))
    ? fs.readdirSync(path.join(getCorpusRoot(), 'projects')).filter((f) => f.endsWith('.md')).length
    : 0,
  corpusOutputs: fs.existsSync(path.join(getCorpusRoot(), 'outputs'))
    ? fs.readdirSync(path.join(getCorpusRoot(), 'outputs')).filter((f) => f.endsWith('.md')).length
    : 0
};
db.close();
console.log(JSON.stringify(result, null, 2));
