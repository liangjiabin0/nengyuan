/**
 * 1) Move parsed fund Markdown to storage/parsed/funds (English, isolated from 数据/)
 * 2) Remove legacy 数据/解析后
 * 3) Deduplicate redundant outputs rows (same project + title; keep richest / distinct venues)
 * 4) Re-export parsed Markdown + corpus projects
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb, persistDbSummary, withTransaction } from '../src/lib/db';
import { getDataRootDir } from '../src/lib/config';
import { getCorpusRoot, corpusDirectory } from '../src/lib/corpus/schema';
import {
  exportParsedFundMarkdown,
  getParsedFundsDir,
  getParsedRootDir
} from '../src/lib/fund-markdown';

type OutputRow = {
  output_key: string;
  project_key: string;
  title: string | null;
  publication: string | null;
  authors: string | null;
};

function normalizeTitle(value: string | null) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizePublication(value: string | null) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function richness(row: OutputRow) {
  const pub = String(row.publication || '').trim();
  const authors = String(row.authors || '').trim();
  return (pub ? 1000 + pub.length : 0) + (authors ? 100 + authors.length : 0) + row.output_key.length;
}

function pickKeepers(rows: OutputRow[]) {
  const withPub = rows.filter((row) => normalizePublication(row.publication));
  const withoutPub = rows.filter((row) => !normalizePublication(row.publication));

  const keep = new Set<string>();
  if (withPub.length) {
    const byPub = new Map<string, OutputRow[]>();
    for (const row of withPub) {
      const key = normalizePublication(row.publication);
      const list = byPub.get(key) || [];
      list.push(row);
      byPub.set(key, list);
    }
    for (const group of byPub.values()) {
      group.sort((a, b) => richness(b) - richness(a));
      keep.add(group[0].output_key);
    }
    // incomplete rows with empty publication are redundant when a titled venue exists
  } else if (withoutPub.length) {
    withoutPub.sort((a, b) => richness(b) - richness(a));
    keep.add(withoutPub[0].output_key);
  }
  return keep;
}

function removeDirIfEmpty(dir: string) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir);
  if (entries.length === 0) fs.rmdirSync(dir);
}

function migrateLegacyParsedDir() {
  const legacyRoot = path.join(getDataRootDir(), '解析后');
  const legacyFunds = path.join(legacyRoot, '基金');
  const target = getParsedFundsDir();
  fs.mkdirSync(target, { recursive: true });

  let moved = 0;
  if (fs.existsSync(legacyFunds)) {
    for (const name of fs.readdirSync(legacyFunds)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      const from = path.join(legacyFunds, name);
      const to = path.join(target, name);
      if (!fs.existsSync(to)) {
        fs.renameSync(from, to);
        moved += 1;
      } else {
        fs.unlinkSync(from);
      }
    }
    // remove leftover non-md then directory
    for (const name of fs.readdirSync(legacyFunds)) {
      fs.rmSync(path.join(legacyFunds, name), { recursive: true, force: true });
    }
    fs.rmdirSync(legacyFunds);
  }
  if (fs.existsSync(legacyRoot)) {
    for (const name of fs.readdirSync(legacyRoot)) {
      fs.rmSync(path.join(legacyRoot, name), { recursive: true, force: true });
    }
    removeDirIfEmpty(legacyRoot);
  }
  return { legacyRoot, target, moved };
}

async function dedupeOutputs() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT output_key, project_key, title, publication, authors
       FROM outputs
       WHERE title IS NOT NULL AND TRIM(title) != ''`
    )
    .all() as OutputRow[];

  const groups = new Map<string, OutputRow[]>();
  for (const row of rows) {
    const key = `${row.project_key}\0${normalizeTitle(row.title)}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }

  const deleteKeys: string[] = [];
  let groupsTouched = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    groupsTouched += 1;
    const keep = pickKeepers(group);
    for (const row of group) {
      if (!keep.has(row.output_key)) deleteKeys.push(row.output_key);
    }
  }

  if (!deleteKeys.length) {
    return { groupsTouched, deleted: 0, before: rows.length, after: rows.length };
  }

  await withTransaction(() => {
    const delOut = db.prepare('DELETE FROM outputs WHERE output_key = ?');
    const delEdge = db.prepare('DELETE FROM edges WHERE source_key = ? OR target_key = ?');
    const delMention = db.prepare('DELETE FROM entity_mentions WHERE record_id = ?');
    const delSearch = db.prepare(
      `DELETE FROM search_records WHERE source_type = 'output' AND source_key = ?`
    );
    const delTerms = db.prepare(
      `DELETE FROM search_terms WHERE record_id IN (
         SELECT record_id FROM search_records WHERE source_type = 'output' AND source_key = ?
       )`
    );
    for (const key of deleteKeys) {
      delTerms.run(key);
      delSearch.run(key);
      delMention.run(key);
      delEdge.run(key, key);
      delOut.run(key);
    }
  });

  const after = (db.prepare('SELECT COUNT(*) AS c FROM outputs').get() as { c: number }).c;
  return { groupsTouched, deleted: deleteKeys.length, before: rows.length, after };
}

async function main() {
  console.log('parsed root:', getParsedRootDir());
  const migrated = migrateLegacyParsedDir();
  console.log('migrated legacy parsed:', migrated);

  const dedupe = await dedupeOutputs();
  console.log('outputs dedupe:', dedupe);

  const corpusProjectsDir = path.join(getCorpusRoot(), corpusDirectory('project'));
  const exported = exportParsedFundMarkdown(getDb(), { corpusProjectsDir });
  console.log('re-exported parsed funds:', exported);

  await persistDbSummary({ includeSlowCounts: true });

  const legacyStill = path.join(getDataRootDir(), '解析后');
  console.log('legacy 解析后 exists:', fs.existsSync(legacyStill));
  console.log('parsed funds count:', fs.readdirSync(getParsedFundsDir()).filter((n) => n.endsWith('.md')).length);
  console.log('done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
