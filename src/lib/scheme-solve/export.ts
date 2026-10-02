import { ZipArchive } from 'archiver';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { buildResearchReviewDocx, researchReviewFileName } from '@/lib/research-review/export';
import { MGPLAN_EXPORT_FILES, buildResultsMarkdown } from './mgplan-results';
import { mgplanOutputDir } from './mgplan-case';
import { getSchemeIdea, getSchemeSession, listSchemeIdeas } from './store';
import { listIdeaReportFiles, schemeIdeaDirectory } from './workspace';

function safeName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_') || '方案';
}

async function zipBuffers(entries: Array<{ name: string; data?: Buffer; filePath?: string }>, fileName: string, title: string) {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<Buffer>((resolve, reject) => {
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(stream);
  for (const entry of entries) {
    if (entry.data) archive.append(entry.data, { name: entry.name });
    else if (entry.filePath && fs.existsSync(entry.filePath)) archive.file(entry.filePath, { name: entry.name });
  }
  await archive.finalize();
  return { bytes: await done, fileName, title };
}

function appendMgplanFiles(sessionId: string, ideaId: string, folder: string) {
  const dir = schemeIdeaDirectory(sessionId, ideaId);
  const outputDir = mgplanOutputDir(sessionId, ideaId);
  const entries: Array<{ name: string; filePath?: string; data?: Buffer }> = [];
  for (const name of ['DESIGN.md', 'result.json', 'RESULTS.md', 'review-small.md', 'review-large.md', 'REPORT.md', 'model.json']) {
    const filePath = path.join(dir, name);
    if (fs.existsSync(filePath)) entries.push({ name: `${folder}/${name}`, filePath });
  }
  for (const name of MGPLAN_EXPORT_FILES) {
    const filePath = path.join(outputDir, name);
    if (fs.existsSync(filePath)) entries.push({ name: `${folder}/mgplan-output/${name}`, filePath });
  }
  return entries;
}

export async function buildSchemeReportDocx(sessionId: string, ideaId: string) {
  const session = await getSchemeSession(sessionId);
  const idea = await getSchemeIdea(ideaId);
  if (!session || !idea || idea.sessionId !== sessionId) {
    throw new Error('想法不存在。');
  }
  const files = listIdeaReportFiles(sessionId, ideaId);
  const body = files.report.trim() || files.results.trim();
  if (!body) throw new Error('该想法还没有技术报告。');
  const bytes = await buildResearchReviewDocx(files.report.trim() || body, idea.title);
  const fileName = researchReviewFileName(`${idea.title}-技术报告`);
  return { bytes, fileName, title: idea.title };
}

export async function buildSchemeIdeaExport(sessionId: string, ideaId: string) {
  const session = await getSchemeSession(sessionId);
  const idea = await getSchemeIdea(ideaId);
  if (!session || !idea || idea.sessionId !== sessionId) {
    throw new Error('想法不存在。');
  }
  const files = listIdeaReportFiles(sessionId, ideaId);
  const extraDirs = ['dispatch', 'loss', 'modelica', 'forecast'].filter((name) =>
    fs.existsSync(path.join(schemeIdeaDirectory(sessionId, ideaId), name))
  );
  const hasMgplan = idea.problemClass === 'mgplan' || fs.existsSync(mgplanOutputDir(sessionId, ideaId));
  if (!hasMgplan && !extraDirs.length) {
    return buildSchemeReportDocx(sessionId, ideaId);
  }
  if (!files.report.trim() && !files.result.trim() && !files.results.trim()) {
    throw new Error('还没有可导出的求解结果。');
  }
  const folder = safeName(idea.title);
  const entries = hasMgplan ? appendMgplanFiles(sessionId, ideaId, folder) : [];
  const ideaDir = schemeIdeaDirectory(sessionId, ideaId);
  for (const name of ['DESIGN.md', 'model.json', 'result.json', 'RESULTS.md', 'review-small.md', 'review-large.md', 'REPORT.md']) {
    const filePath = path.join(ideaDir, name);
    if (fs.existsSync(filePath) && !entries.some((entry) => entry.filePath === filePath)) {
      entries.push({ name: `${folder}/${name}`, filePath });
    }
  }
  for (const dirName of extraDirs) {
    const dir = path.join(ideaDir, dirName);
    for (const file of fs.readdirSync(dir, { recursive: true })) {
      const filePath = path.join(dir, String(file));
      if (fs.statSync(filePath).isFile()) {
        entries.push({ name: `${folder}/${dirName}/${String(file).replace(/\\/g, '/')}`, filePath });
      }
    }
  }
  if (files.report.trim()) {
    const docx = await buildSchemeReportDocx(sessionId, ideaId);
    entries.unshift({ name: `${folder}/${docx.fileName}`, data: Buffer.from(docx.bytes) });
  } else if (files.results.trim() || files.result.trim()) {
    const markdown = files.results.trim() || buildResultsMarkdown(idea, JSON.parse(files.result || '{}'));
    const docxBytes = await buildResearchReviewDocx(markdown, `${idea.title}-规划结果`);
    entries.unshift({
      name: `${folder}/${researchReviewFileName(`${idea.title}-规划结果`)}`,
      data: Buffer.from(docxBytes)
    });
  }
  if (!entries.length) throw new Error('还没有可导出的规划结果。');
  return zipBuffers(entries, `${folder}-规划结果.zip`, idea.title);
}

export async function buildSchemeSessionZip(sessionId: string) {
  const session = await getSchemeSession(sessionId);
  if (!session) throw new Error('方案不存在。');
  const ideas = (await listSchemeIdeas(sessionId)).filter((idea) => idea.solvability === 'solvable');
  const exportable = ideas.filter((idea) => {
    const files = listIdeaReportFiles(sessionId, idea.id);
    return Boolean(files.report.trim() || files.result.trim() || files.results.trim());
  });
  if (!exportable.length) throw new Error('还没有可导出的技术报告。');
  if (exportable.length === 1) {
    return buildSchemeIdeaExport(sessionId, exportable[0]!.id);
  }

  const entries: Array<{ name: string; data?: Buffer; filePath?: string }> = [];
  for (const idea of exportable) {
    const folder = safeName(idea.title);
    const files = listIdeaReportFiles(sessionId, idea.id);
    if (files.report.trim()) {
      const docx = await buildSchemeReportDocx(sessionId, idea.id);
      entries.push({ name: `${folder}/${docx.fileName}`, data: Buffer.from(docx.bytes) });
    }
    if (idea.problemClass === 'mgplan') {
      entries.push(...appendMgplanFiles(sessionId, idea.id, folder));
    } else {
      const dir = schemeIdeaDirectory(sessionId, idea.id);
      for (const name of ['DESIGN.md', 'model.json', 'result.json', 'RESULTS.md', 'review-small.md', 'review-large.md', 'REPORT.md']) {
        const filePath = path.join(dir, name);
        if (fs.existsSync(filePath)) entries.push({ name: `${folder}/${name}`, filePath });
      }
      for (const dirName of ['dispatch', 'loss', 'modelica', 'forecast']) {
        const extra = path.join(dir, dirName);
        if (!fs.existsSync(extra)) continue;
        for (const file of fs.readdirSync(extra, { recursive: true })) {
          const filePath = path.join(extra, String(file));
          if (fs.statSync(filePath).isFile()) {
            entries.push({ name: `${folder}/${dirName}/${String(file).replace(/\\/g, '/')}`, filePath });
          }
        }
      }
    }
  }
  return zipBuffers(
    entries,
    `${safeName(session.title) || '方案求解'}.zip`,
    session.title
  );
}
