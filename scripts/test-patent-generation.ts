import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { buildPatentExportBundle } from '../src/lib/patent-generation/export';
import { runPatentPipeline } from '../src/lib/patent-generation/pipeline';
import { parsePatentSource } from '../src/lib/patent-generation/source-parser';
import {
  createPatentProject,
  getPatentProject,
  updatePatentProject
} from '../src/lib/patent-generation/store';
import { countAbstractCharacters, splitClaims } from '../src/lib/patent-generation/validators';

const sourcePath = process.env.PATENT_TEST_DOCX
  || 'C:\\Users\\lenovo\\Desktop\\计及算力负载时空特性的算电热系统优化调度2.0.docx';

async function main() {
  const buffer = await fs.readFile(sourcePath);
  const sourceArchive = await JSZip.loadAsync(buffer);
  const documentXml = await sourceArchive.file('word/document.xml')!.async('string');
  const parsed = await parsePatentSource(path.basename(sourcePath), buffer);
  console.log(JSON.stringify({
    inventory: {
      chars: parsed.charCount,
      tables: parsed.tables.length,
      figures: parsed.figures.length,
      mediaCount: parsed.metadata.mediaCount,
      imageCount: parsed.metadata.imageCount,
      formulas: parsed.formulaObjectsDetected,
      equationProgramIds: parsed.metadata.equationProgramIds,
      drawingTags: (documentXml.match(/<w:drawing\b/g) || []).length,
      inlineTags: (documentXml.match(/<wp:inline\b/g) || []).length,
      anchorTags: (documentXml.match(/<wp:anchor\b/g) || []).length,
      legacyImages: (documentXml.match(/<v:imagedata\b/g) || []).length
    }
  }, null, 2));
  assert.ok(parsed.charCount >= 15_000, `expected rich text, got ${parsed.charCount}`);
  assert.equal(parsed.tables.length, 9, 'table inventory must be lossless');
  assert.equal(parsed.figures.length, 24, 'figure inventory must be lossless');
  assert.equal(parsed.formulaObjectsDetected, 217, 'MathType OLE inventory must be lossless');
  assert.equal(
    parsed.formulas.filter((formula) => formula.latex || formula.warnings.length).length,
    217,
    'every equation must have recovered LaTeX or an explicit warning'
  );
  console.log(JSON.stringify({
    parse: {
      chars: parsed.charCount,
      tables: parsed.tables.length,
      figures: parsed.figures.length,
      formulasDetected: parsed.formulaObjectsDetected,
      formulasRecovered: parsed.formulaObjectsRecovered,
      warnings: parsed.warnings.length
    }
  }, null, 2));

  if (process.argv.includes('--parse-only')) return;

  const resumeId = process.argv
    .find((argument) => argument.startsWith('--project-id='))
    ?.slice('--project-id='.length);
  let project = resumeId ? getPatentProject(resumeId) : null;
  if (!project) {
    project = await createPatentProject({
      name: path.basename(sourcePath),
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer,
      parsed
    });
    assert.ok(project);
    project = updatePatentProject(project!.id, {
      applicant: '端到端测试申请人（非提交信息）',
      inventors: ['端到端测试发明人'],
      answers: {
        'formula-recovery': '测试确认：仅使用已可靠恢复的公式；未恢复公式不作为独立权利要求必要限定，并在正式提交前逐式人工核对。'
      }
    });
    assert.ok(project);
  } else {
    const missingAnswers = Object.fromEntries(
      project.blockers
        .filter((blocker) => !blocker.resolved)
        .map((blocker) => [
          blocker.id,
          `端到端测试确认：请依据源文档结构化正文和已恢复公式修复该问题，不得新增源文档未记载内容。${blocker.question}`
        ])
    );
    project = updatePatentProject(project.id, { answers: missingAnswers });
  }

  if (!process.argv.includes('--export-only')) {
    const events: string[] = [];
    project = await runPatentPipeline(project!.id, (event) => {
      if (event.type === 'status') {
        const line = `${event.progress}% ${event.stage}: ${event.detail}`;
        events.push(line);
        console.log(line);
      }
    });

    for (let followUp = 0; followUp < 2 && project.status === 'needs_input'; followUp += 1) {
      const missingAnswers = Object.fromEntries(
        project.blockers
          .filter((blocker) => !blocker.resolved)
          .map((blocker) => [
            blocker.id,
            `端到端测试确认：以源文档明确记载及其可直接推出的技术内容为边界。${blocker.question}`
          ])
      );
      project = updatePatentProject(project.id, { answers: missingAnswers })!;
      project = await runPatentPipeline(project.id, (event) => {
        if (event.type === 'status') console.log(`${event.progress}% ${event.stage}: ${event.detail}`);
      });
    }
  }

  project = getPatentProject(project.id)!;
  assert.ok(project.disclosure, 'disclosure must be generated');
  assert.ok(project.priorArt?.candidates.length, 'prior-art candidates must be generated');
  assert.ok(project.strategy, 'claim strategy must be generated');
  assert.ok(project.drawings?.assets?.length, 'specification drawings must be generated');
  assert.ok(project.draft, 'full patent draft must be generated');
  assert.ok(project.audit, 'quality audit must be generated');
  assert.ok(splitClaims(project.draft!.claims).length >= 8, 'claim set must contain at least 8 claims');
  assert.ok(countAbstractCharacters(project.draft!.abstract) <= 300, 'abstract must not exceed 300 Chinese characters');
  assert.ok(
    project.draft!.drawingDescription.trim() && project.draft!.drawingDescription.trim() !== '无',
    'drawing description must be present'
  );

  const bundle = await buildPatentExportBundle(project);
  const outputDir = path.join(process.cwd(), 'outputs', 'patent-test');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, bundle.fileName);
  await fs.writeFile(outputPath, bundle.buffer);
  const archive = await JSZip.loadAsync(bundle.buffer);
  const docxName = Object.keys(archive.files).find((name) => name.endsWith('.docx'));
  assert.ok(docxName, 'bundle must contain DOCX');
  assert.ok(Object.keys(archive.files).some((name) => name.endsWith('质量报告.md')), 'bundle must contain quality report');
  assert.ok(
    Object.keys(archive.files).some((name) => name.startsWith('说明书附图/') && /\.(png|jpe?g|gif|svg)$/i.test(name)),
    'bundle must contain drawing image files'
  );
  const docxArchive = await JSZip.loadAsync(await archive.file(docxName!)!.async('nodebuffer'));
  assert.ok(docxArchive.file('word/document.xml'), 'generated DOCX must be an openable Word package');
  assert.ok(
    Object.keys(docxArchive.files).some((name) => name.startsWith('word/media/')),
    'generated DOCX must embed drawing media'
  );

  console.log(JSON.stringify({
    projectId: project.id,
    status: project.status,
    stage: project.currentStage,
    qualityScore: project.qualityScore,
    drawings: project.drawings!.assets.length,
    claims: splitClaims(project.draft!.claims).length,
    abstractChars: countAbstractCharacters(project.draft!.abstract),
    priorArtCandidates: project.priorArt!.candidates.length,
    outputPath
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
