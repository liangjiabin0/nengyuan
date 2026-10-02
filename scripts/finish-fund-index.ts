import fs from 'node:fs';
import path from 'node:path';
import { getDb, persistDbSummary, withTransaction } from '../src/lib/db';
import { indexProjectInDb } from '../src/lib/search-index';
import { syncFtsFromSearchRecords } from '../src/lib/fts-index';
import { indexDocumentsFast } from '../src/lib/doc-index';
import { getCorpusRoot, corpusDirectory } from '../src/lib/corpus/schema';
import { exportParsedFundMarkdown, getParsedFundsDir } from '../src/lib/fund-markdown';

async function main() {
  console.log('ensure parsed markdown...');
  const corpusProjectsDir = path.join(getCorpusRoot(), corpusDirectory('project'));
  const parsed = exportParsedFundMarkdown(getDb(), { corpusProjectsDir });
  console.log('parsed', parsed);

  console.log('indexing projects...');
  const n = await withTransaction(async (db) => {
    const projects = db.prepare('SELECT * FROM projects').all() as Array<Record<string, unknown> & { project_key: string }>;
    for (const project of projects) indexProjectInDb(db, project);
    return projects.length;
  }, true);
  syncFtsFromSearchRecords();
  console.log('projects indexed', n);

  const wp = (
    getDb()
      .prepare("SELECT paper_key FROM paper_documents WHERE paper_key LIKE 'whitepaper:%'")
      .all() as Array<{ paper_key: string }>
  ).map((row) => row.paper_key);
  console.log('whitepapers', wp);
  const docs = await indexDocumentsFast({ paperKeys: wp, fillMissing: false });
  console.log('docs', docs);
  await persistDbSummary({ includeSlowCounts: true });

  const parsedCount = fs.readdirSync(getParsedFundsDir()).filter((f) => f.endsWith('.md')).length;
  const cp = fs.existsSync(corpusProjectsDir)
    ? fs.readdirSync(corpusProjectsDir).filter((f) => f.endsWith('.md')).length
    : 0;
  const outputsDir = path.join(getCorpusRoot(), 'outputs');
  const out = fs.existsSync(outputsDir) ? fs.readdirSync(outputsDir).filter((f) => f.endsWith('.md')).length : 0;
  console.log(
    JSON.stringify(
      {
        parsedCount,
        corpusProjects: cp,
        corpusOutputs: out,
        projects: (getDb().prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c,
        outputs: (getDb().prepare('SELECT COUNT(*) AS c FROM outputs').get() as { c: number }).c
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
