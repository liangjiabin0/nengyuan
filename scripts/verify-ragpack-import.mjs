import { config } from '../src/lib/config.js';
import { getBundleRoot } from '../src/lib/bundle-store.js';
import { getDb } from '../src/lib/db.js';
import { searchRecords } from '../src/lib/search-index.js';
import fs from 'node:fs';

const db = getDb();
const onF = db.prepare("SELECT COUNT(*) c FROM paper_documents WHERE pdf_path LIKE 'F:%'").get().c;
const onBundle = db.prepare("SELECT COUNT(*) c FROM paper_documents WHERE pdf_path LIKE '%ragpack%'").get().c;
const sample = db.prepare('SELECT pdf_path FROM paper_documents LIMIT 1').get();
const stats = {
  databasePath: config.databasePath,
  bundleRoot: getBundleRoot(),
  papers: db.prepare('SELECT COUNT(*) c FROM paper_documents').get().c,
  mentors: db.prepare('SELECT COUNT(*) c FROM mentor_profiles').get().c,
  searchRecords: db.prepare('SELECT COUNT(*) c FROM search_records').get().c,
  pathsOnF: onF,
  pathsOnBundle: onBundle,
  samplePath: sample?.pdf_path,
  pdfExists: sample?.pdf_path ? fs.existsSync(sample.pdf_path) : false
};
const hits = await searchRecords('电力系统', 3);
console.log(JSON.stringify({ stats, searchHits: hits.length, topTitle: hits[0]?.title }, null, 2));
