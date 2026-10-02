import fs from 'node:fs';
import path from 'node:path';
import unzipper from 'unzipper';
import { setBundleMeta } from '../bundle-store';
import { ensureDb, getDb, invalidateDbCaches, resetDb } from '../db';
import { restoreDatabase } from '../db/pg-tools';
import { mentorBundleRel, paperBundleRel } from './paths';
import { RAGPACK_FORMAT, type RagpackImportResult, type RagpackManifest } from './types';

function readManifest(bundleRoot: string): RagpackManifest {
  const raw = fs.readFileSync(path.join(bundleRoot, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw) as RagpackManifest;
  if (manifest.format !== RAGPACK_FORMAT) {
    throw new Error(`不支持的包格式: ${manifest.format}`);
  }
  return manifest;
}

async function remapPathsAt(bundleRoot: string, manifest: RagpackManifest) {
  const db = getDb();
  let remappedPapers = 0;
  let remappedMentors = 0;

  const papers = await db.prepare('SELECT paper_key FROM paper_documents').all<{ paper_key: string }>();
  const updatePaper = db.prepare('UPDATE paper_documents SET file_path = ?, pdf_path = ? WHERE paper_key = ?');
  for (const paper of papers) {
    const rel = manifest.files.papers[paper.paper_key] || paperBundleRel(paper.paper_key);
    const abs = path.join(bundleRoot, rel);
    if (fs.existsSync(abs)) {
      await updatePaper.run(abs, abs, paper.paper_key);
      remappedPapers += 1;
    }
  }

  const mentors = await db.prepare('SELECT mentor_key FROM mentor_profiles').all<{ mentor_key: string }>();
  const updateMentor = db.prepare('UPDATE mentor_profiles SET file_path = ? WHERE mentor_key = ?');
  for (const mentor of mentors) {
    const rel = manifest.files.mentors[mentor.mentor_key] || mentorBundleRel(mentor.mentor_key);
    const abs = path.join(bundleRoot, rel);
    if (fs.existsSync(abs)) {
      await updateMentor.run(abs, mentor.mentor_key);
      remappedMentors += 1;
    }
  }

  return { remappedPapers, remappedMentors };
}

export async function importRagPack(zipPath: string): Promise<RagpackImportResult> {
  if (!fs.existsSync(zipPath)) throw new Error(`找不到包文件: ${zipPath}`);

  const bundleRoot = path.join(process.cwd(), 'storage', 'ragpack', 'active');

  await resetDb();
  if (fs.existsSync(bundleRoot)) fs.rmSync(bundleRoot, { recursive: true, force: true });
  fs.mkdirSync(bundleRoot, { recursive: true });

  await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: bundleRoot })).promise();

  const manifest = readManifest(bundleRoot);
  const dumpPath = path.join(bundleRoot, 'database', 'ai4es.dump');
  if (!fs.existsSync(dumpPath)) {
    throw new Error('包内缺少 database/ai4es.dump（Postgres 导出版本）。旧 rag.sqlite 包请先在源机用 npm run db:migrate-pg 迁库后再导出。');
  }

  await restoreDatabase(dumpPath);
  await ensureDb();

  const { remappedPapers, remappedMentors } = await remapPathsAt(bundleRoot, manifest);

  setBundleMeta({
    activeRoot: bundleRoot,
    databasePath: dumpPath,
    importedAt: new Date().toISOString(),
    format: manifest.format,
    version: manifest.version
  });

  await resetDb();
  invalidateDbCaches();
  await ensureDb();

  const { persistDbSummary } = await import('../db');
  const indexStats = await import('../search-index').then((module) => module.getIndexStatsUncached(false));
  await persistDbSummary({
    papers: manifest.stats.papers,
    patents: 0,
    mentors: manifest.stats.mentors,
    indexStats: { ...indexStats, searchRecords: manifest.stats.searchRecords },
    bundleActive: true
  });
  await import('../corpus/export').then((module) => module.exportKnowledgeCorpus());

  return { bundleRoot, manifest, remappedPapers, remappedMentors };
}
