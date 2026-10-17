/**
 * E2E: upload the desktop PDF disclosure and run OpenCode patent pipeline.
 * Usage: npx tsx scripts/test-patent-pdf-e2e.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runPatentPipeline } from '../src/lib/patent-generation/pipeline';
import { parsePatentSource } from '../src/lib/patent-generation/source-parser';
import {
  createPatentProject,
  getPatentProject,
  updatePatentProject
} from '../src/lib/patent-generation/store';

const sourcePath =
  process.env.PATENT_TEST_PDF
  || 'C:\\Users\\Lenovo\\Desktop\\计及算力负载时空特性的算电热系统优化调度2.0.pdf';

async function main() {
  console.log('[1] reading', sourcePath);
  const buffer = await fs.readFile(sourcePath);
  console.log('[1] bytes', buffer.length);

  console.log('[2] parsing…');
  const parsed = await parsePatentSource(path.basename(sourcePath), buffer);
  console.log(JSON.stringify({
    chars: parsed.charCount,
    tables: parsed.tables.length,
    figures: parsed.figures.length,
    formulas: parsed.formulas.length,
    title: parsed.metadata.title,
    warnings: parsed.warnings.slice(0, 8)
  }, null, 2));
  assert.ok(parsed.charCount > 500, `正文过短: ${parsed.charCount}`);

  console.log('[3] create project');
  let project = await createPatentProject({
    name: path.basename(sourcePath),
    mediaType: 'application/pdf',
    buffer,
    parsed
  });
  assert.ok(project);
  project = updatePatentProject(project!.id, {
    applicant: 'PDF端到端测试申请人（非提交信息）',
    inventors: ['PDF端到端测试发明人'],
    answers: {
      'formula-recovery': '测试确认：仅使用已可靠恢复的公式；未恢复公式不作为独立权利要求必要限定。',
      'source-detail': '资料已足够，可按交底上位概括继续撰写。'
    }
  });
  assert.ok(project);
  console.log('[3] project', project!.id, 'blockers', project!.blockers.map((b) => `${b.id}:${b.resolved}`));

  const unresolved = project!.blockers.filter((b) => !b.resolved);
  if (unresolved.length) {
    console.log('[3] still unresolved, answering all as generic confirmation');
    const answers: Record<string, string> = { ...project!.answers };
    for (const blocker of unresolved) {
      answers[blocker.id] = '测试确认：可按交底继续撰写，缺口采用上位概括。';
    }
    project = updatePatentProject(project!.id, { answers })!;
  }

  console.log('[4] run OpenCode patent pipeline…');
  const started = Date.now();
  project = await runPatentPipeline(project!.id, (event) => {
    if (event.type === 'status') {
      console.log(`  [${event.progress}%] ${event.stage}: ${event.detail}`);
    } else if (event.type === 'artifact') {
      console.log(`  artifact=${event.kind} status=${event.project.status}`);
    } else if (event.type === 'error') {
      console.error('  ERROR', event.error);
    } else if (event.type === 'done') {
      console.log(`  done status=${event.project.status} stage=${event.project.currentStage}`);
    }
  });

  const finalProject = getPatentProject(project!.id)!;
  console.log(JSON.stringify({
    elapsedSec: Math.round((Date.now() - started) / 1000),
    id: finalProject.id,
    status: finalProject.status,
    stage: finalProject.currentStage,
    qualityScore: finalProject.qualityScore,
    hasDisclosure: Boolean(finalProject.disclosure),
    hasPriorArt: Boolean(finalProject.priorArt),
    hasStrategy: Boolean(finalProject.strategy),
    hasDraft: Boolean(finalProject.draft),
    hasDrawings: Boolean(finalProject.drawings?.assets?.length),
    hasAudit: Boolean(finalProject.audit),
    blockers: finalProject.blockers.filter((b) => !b.resolved).map((b) => b.question),
    error: finalProject.error || null
  }, null, 2));

  assert.ok(
    finalProject.status === 'ready'
    || finalProject.status === 'needs_input'
    || finalProject.disclosure,
    `unexpected terminal status: ${finalProject.status}`
  );
  console.log('[ok] pdf e2e finished');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
