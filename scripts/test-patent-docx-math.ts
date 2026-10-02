import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildMathAwareParagraphs, latexToOmml, splitTextWithMath } from '../src/lib/patent-generation/docx-math';
import { buildPatentDocx } from '../src/lib/patent-generation/export';
import type { PatentProject } from '../src/lib/patent-generation/types';

async function main() {
  const segments = splitTextWithMath('目标为 $$P=\\sum_{i=1}^{N}\\frac{\\lambda_i}{\\mu_i}$$ ，且约束 $x\\ge 0$。');
  assert.equal(segments.filter((s) => s.type === 'math').length, 2);

  const omml = latexToOmml(String.raw`P=\sum_{i=1}^{N}\frac{\lambda_i}{\mu_i}`, true);
  assert.ok(omml && omml.includes('<m:oMath') && omml.includes('<m:f'), 'OMML should contain fraction');

  const paragraphs = buildMathAwareParagraphs(
    '在实施方式中，系统按式\n\n$$E=mc^2$$\n\n计算能量，并满足 $P\\le P_{max}$。'
  );
  assert.ok(paragraphs.length >= 2);

  const project = {
    id: 'math-test',
    name: 'math-test',
    status: 'ready',
    applicant: '测试单位',
    inventors: ['测试'],
    draft: {
      title: '一种测试方法',
      abstract: '摘要含行内 $a+b=c$。',
      abstractFigure: '图1',
      claims: '1. 一种方法，其特征在于满足 $x_{i}\\in\\{0,1\\}$。\n2. 根据权利要求1所述的方法，其中 $$y=\\frac{1}{2}x$$。',
      technicalField: '本发明涉及测试。',
      backgroundArt: '现有技术缺少公式表达。',
      inventionSummary: '本发明建立目标 $$J=\\sum_i c_i$$。',
      drawingDescription: '图1为流程图。',
      embodiments: '具体地，按 $$P=\\sum_{i=1}^{N}\\frac{\\lambda_i}{\\mu_i}$$ 计算，并保证 $P\\ge 0$。',
      drawings: []
    },
    drawings: { assets: [], generatedFromSuggestions: false, notes: [] }
  } as unknown as PatentProject;

  const buffer = await buildPatentDocx(project);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')!.async('string');
  assert.ok(/<m:oMath\b/.test(xml), 'DOCX must embed OMML equations');
  assert.ok(/<m:oMathPara\b/.test(xml), 'display equations must use oMathPara');
  assert.ok(!/<undefined>/.test(xml), 'OMML must not be wrapped in <undefined>');
  assert.ok(/<m:f\b/.test(xml), 'DOCX must contain fraction math');
  assert.ok(!/\$\$P=/.test(xml), 'display latex delimiters should not remain as plain text');
  assert.ok(
    /<m:nary>[\s\S]*?<m:e>[\s\S]*?<m:f\b[\s\S]*?<\/m:nary>/.test(xml),
    'sum/fraction equation should keep fraction inside nary body'
  );
  assert.ok(!/<m:nary>[\s\S]*?<m:e\s*\/>\s*<\/m:nary>/.test(xml), 'nary body must not stay empty');
  const settings = await zip.file('word/settings.xml')!.async('string');
  assert.ok(/<m:mathPr\b/.test(settings), 'settings.xml must declare mathPr');
  assert.ok(
    /<m:sty m:val="i"\s*\/>/.test(xml),
    'variables must use italic math style (MathType-like)'
  );
  const upright = latexToOmml(String.raw`\mathrm{PUE}`, false) || '';
  assert.ok(/<m:nor\b/.test(upright), '\\mathrm should keep upright nor');
  assert.ok(/<m:sty m:val="p"\s*\/>/.test(upright), '\\mathrm should stay plain, not italic');
  assert.ok(!/<m:sty m:val="undefined"\s*\/>/.test(upright), 'sty=undefined must be repaired');
  const italicVar = latexToOmml(String.raw`x_i`, false) || '';
  assert.ok(/<m:sty m:val="i"\s*\/>/.test(italicVar), 'variables like x_i must be italic');
  assert.ok(
    /w:ascii="Times New Roman"/.test(italicVar),
    'math runs must use Times New Roman'
  );
  assert.ok(
    /<m:mathFont m:val="Times New Roman"\s*\/>/.test(settings),
    'document math font must be Times New Roman'
  );
  console.log('test-patent-docx-math: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
