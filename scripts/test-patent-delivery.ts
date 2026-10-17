import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { buildPatentExportBundle } from '../src/lib/patent-generation/export';
import { inspectRenderedDiagram } from '../src/lib/patent-generation/figures';
import { runPatentPipeline } from '../src/lib/patent-generation/pipeline';
import { parsePatentSource } from '../src/lib/patent-generation/source-parser';
import {
  createPatentProject,
  getPatentProjectDirectory,
  getPatentProject,
  updatePatentProject
} from '../src/lib/patent-generation/store';
import { countAbstractCharacters, splitClaims } from '../src/lib/patent-generation/validators';

const sourcePath = process.env.PATENT_TEST_FILE
  || 'C:\\Users\\Lenovo\\计及算力负载时空特性的算电热系统优化调度2.0.pdf';
const resumeProjectId = process.env.PATENT_PROJECT_ID;

function answerFor(question: string) {
  if (/公式/.test(question)) {
    return '仅采用上传材料中已明确提取的公式和变量关系；无法可靠恢复的公式不作为独立权利要求必要限定。';
  }
  if (/附图|流程图|结构图|数据流图/.test(question)) {
    return '根据材料内容自动生成方法流程图、系统结构图和数据流图，无需再次确认。';
  }
  return [
    '以上传材料明确记载的技术方案为边界。',
    '核心实施例采用材料中的完整协同优化场景：输入算力负载、电网、通信网络和热力数据，',
    '建立算力时空迁移、光纤传输、电力平衡、制冷热力及服务质量约束，',
    '以系统总成本最小为目标求解并输出各时段算力迁移和设备调度结果。',
    '材料未明确给出且不影响实施的具体数值采用上位参数描述，不写入独立权利要求。'
  ].join('');
}

async function main() {
  const sourceBuffer = await fs.readFile(sourcePath);
  const parsed = await parsePatentSource(path.basename(sourcePath), sourceBuffer);
  assert.ok(parsed.charCount > 20_000, `PDF 正文过短：${parsed.charCount}`);
  assert.deepEqual(parsed.metadata.authors, ['苏璇', '于宗民', '巨云涛', '王碧清']);
  assert.equal(parsed.metadata.applicant, '北方工业大学');

  let project = resumeProjectId
    ? getPatentProject(resumeProjectId)
    : await createPatentProject({
        name: path.basename(sourcePath),
        mediaType: 'application/pdf',
        buffer: sourceBuffer,
        parsed
      });
  assert.ok(project);
  assert.equal(project!.applicant, '北方工业大学');
  assert.deepEqual(project!.inventors, ['苏璇', '于宗民', '巨云涛', '王碧清']);
  assert.ok(!project!.blockers.some((item) => item.category === 'identity'));
  assert.ok(!project!.blockers.some((item) => item.id === 'figure-confirm'));

  console.log(`project=${project!.id}`);
  for (let round = 0; project!.status !== 'ready' && round < 5; round += 1) {
    project = await runPatentPipeline(project!.id, (event) => {
      if (event.type === 'status') {
        console.log(`${event.progress}% [${event.stage}] ${event.detail}`);
      }
      if (event.type === 'error') console.error(`[pipeline] ${event.error}`);
    });
    if (project.status === 'ready') break;
    const unresolved = project.blockers.filter((item) => !item.resolved);
    if (!unresolved.length) {
      throw new Error(`流程未完成且没有可回答问题：${project.status}/${project.currentStage}`);
    }
    project = updatePatentProject(project.id, {
      answers: Object.fromEntries(unresolved.map((item) => [item.id, answerFor(item.question)]))
    });
    assert.ok(project);
  }

  project = getPatentProject(project!.id);
  assert.ok(project);
  assert.equal(project!.status, 'ready', `最终状态：${project!.status}，错误：${project!.error || '无'}`);
  assert.ok(project!.audit?.passed, '自动审校必须通过');
  assert.ok(project!.draft);
  assert.ok(project!.drawings);
  assert.equal(project!.drawings!.assets.length, 3, '必须生成三幅基础附图');
  assert.match(project!.drawings!.assets[0].caption, /方法流程图/);
  assert.match(project!.drawings!.assets[1].caption, /系统结构图/);
  assert.match(project!.drawings!.assets[2].caption, /数据流图/);
  const projectDir = getPatentProjectDirectory(project!.id);
  for (const asset of project!.drawings!.assets) {
    assert.ok(asset.diagram, `图${asset.figureNumber}缺少结构化图元`);
    const png = await fs.readFile(path.join(projectDir, asset.relativePath));
    const svg = asset.svgRelativePath
      ? await fs.readFile(path.join(projectDir, asset.svgRelativePath), 'utf8')
      : '';
    const inspection = await inspectRenderedDiagram(asset.diagram!, png, svg);
    assert.ok(
      inspection.passed,
      `图${asset.figureNumber}内容级质量检查失败：${inspection.issues.join('；')}`
    );
  }

  const draft = project!.draft!;
  const claims = splitClaims(draft.claims);
  assert.ok(claims.length >= 10 && claims.length <= 16, `权利要求数量不合格：${claims.length}`);
  assert.ok(countAbstractCharacters(draft.abstract) <= 300, '摘要超过 300 字');
  assert.ok(draft.embodiments.replace(/\s+/g, '').length >= 2_500, '具体实施方式不足 2500 字');
  assert.ok(draft.drawingDescription.includes('图1'));
  assert.ok(draft.drawingDescription.includes('图2'));
  assert.ok(draft.drawingDescription.includes('图3'));
  assert.ok(!/TBD|TODO|\[待确认\]|未恢复/i.test(JSON.stringify(draft)), '终稿仍含占位符');

  const bundle = await buildPatentExportBundle(project!);
  const outputDir = path.join(process.cwd(), 'outputs', 'patent-delivery');
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, bundle.fileName);
  await fs.writeFile(outputPath, bundle.buffer);

  const archive = await JSZip.loadAsync(bundle.buffer);
  const docxName = Object.keys(archive.files).find((name) => name.endsWith('.docx'));
  assert.ok(docxName, '申请包缺少 DOCX');
  const drawingFiles = Object.keys(archive.files)
    .filter((name) => /^说明书附图\/图\d+\.png$/i.test(name));
  assert.equal(drawingFiles.length, 3, `申请包附图数量不正确：${drawingFiles.length}`);
  const docx = await JSZip.loadAsync(await archive.file(docxName!)!.async('nodebuffer'));
  const embeddedMedia = Object.keys(docx.files).filter((name) => name.startsWith('word/media/'));
  assert.ok(embeddedMedia.length >= 3, `DOCX 嵌入附图不足：${embeddedMedia.length}`);
  const documentXml = await docx.file('word/document.xml')!.async('string');
  for (const section of ['权利要求书', '技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式', '说明书附图', '说明书摘要']) {
    assert.ok(documentXml.includes(section), `DOCX 缺少章节：${section}`);
  }

  const report = {
    projectId: project!.id,
    status: project!.status,
    qualityScore: project!.qualityScore,
    applicant: project!.applicant,
    inventors: project!.inventors,
    sourceChars: parsed.charCount,
    claims: claims.length,
    abstractChars: countAbstractCharacters(draft.abstract),
    embodimentChars: draft.embodiments.replace(/\s+/g, '').length,
    drawings: project!.drawings!.assets.map((item) => item.caption),
    embeddedMedia: embeddedMedia.length,
    outputPath
  };
  await fs.writeFile(
    path.join(outputDir, 'delivery-report.json'),
    JSON.stringify(report, null, 2),
    'utf8'
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
