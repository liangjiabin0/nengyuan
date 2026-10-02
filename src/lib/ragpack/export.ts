import fs, { createWriteStream } from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { getDb } from '../db';
import { dumpDatabase } from '../db/pg-tools';
import { getIndexStats } from '../search-index';
import { mentorBundleRel, paperBundleRel } from './paths';
import { resolveMentorFilePath } from '../mentors';
import { RAGPACK_FORMAT, RAGPACK_VERSION, type RagpackExportResult, type RagpackManifest } from './types';

function copyIfExists(src: string, dest: string) {
  if (!src || !fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

export async function exportRagPack(outPath?: string): Promise<RagpackExportResult> {
  const db = getDb();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = path.join(process.cwd(), 'storage', 'ragpack', `export-${stamp}`);
  const target = outPath || path.join(process.cwd(), 'storage', 'exports', `research-${stamp}.ragpack`);

  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const papers = await db.prepare('SELECT paper_key, pdf_path, file_path FROM paper_documents').all<{
    paper_key: string;
    pdf_path: string;
    file_path: string;
  }>();
  const mentors = await db.prepare('SELECT mentor_key, file_path, content FROM mentor_profiles').all<{
    mentor_key: string;
    file_path: string;
    content: string;
  }>();

  const paperFiles: Record<string, string> = {};
  const mentorFiles: Record<string, string> = {};
  const skippedFiles: string[] = [];
  let copiedPapers = 0;
  let copiedMentors = 0;

  for (const paper of papers) {
    const rel = paperBundleRel(paper.paper_key);
    const dest = path.join(staging, rel);
    const src = paper.pdf_path || paper.file_path;
    if (copyIfExists(src, dest)) {
      paperFiles[paper.paper_key] = rel;
      copiedPapers += 1;
    } else {
      skippedFiles.push(src || paper.paper_key);
    }
  }

  for (const mentor of mentors) {
    const rel = mentorBundleRel(mentor.mentor_key);
    const dest = path.join(staging, rel);
    if (copyIfExists(resolveMentorFilePath(mentor.file_path || ''), dest)) {
      mentorFiles[mentor.mentor_key] = rel;
      copiedMentors += 1;
    } else if (mentor.content?.trim()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, mentor.content, 'utf8');
      mentorFiles[mentor.mentor_key] = rel;
      copiedMentors += 1;
    } else {
      skippedFiles.push(mentor.file_path || mentor.mentor_key);
    }
  }

  const index = await getIndexStats();
  const manifest: RagpackManifest = {
    format: RAGPACK_FORMAT,
    version: RAGPACK_VERSION,
    createdAt: new Date().toISOString(),
    stats: {
      papers: papers.length,
      mentors: mentors.length,
      searchRecords: index.searchRecords,
      paperChunks: Number((await db.prepare('SELECT COUNT(*) AS c FROM paper_chunks').get<{ c: number }>())?.c || 0)
    },
    files: { papers: paperFiles, mentors: mentorFiles }
  };

  fs.mkdirSync(path.join(staging, 'database'), { recursive: true });
  await dumpDatabase(path.join(staging, 'database', 'ai4es.dump'));
  fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(target);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(staging, false);
    archive.finalize();
  });

  fs.rmSync(staging, { recursive: true, force: true });

  return {
    outPath: target,
    sizeBytes: fs.statSync(target).size,
    manifest,
    copiedPapers,
    copiedMentors,
    skippedFiles: skippedFiles.slice(0, 50)
  };
}
