// 【按线上版本还原】依据 dist/runtime/api-app.mjs 中的 src/lib/office-docs-cli.ts 还原。
import fs from 'node:fs';
import path from 'node:path';

export const DOCX_SKILL = 'docx';
export const PDF_SKILL = 'pdf';
export const XLSX_SKILL = 'xlsx';
export const PPTX_SKILL = 'pptx';
export const OFFICE_DOCS_SKILLS = new Set<string>([DOCX_SKILL, PDF_SKILL, XLSX_SKILL, PPTX_SKILL]);

export function officeDocsVenvPythonRelPath() {
  return process.platform === 'win32'
    ? 'tools/office-docs-venv/Scripts/python.exe'
    : 'tools/office-docs-venv/bin/python';
}

export function annotateOfficeDocsSkillContent(content: string, skillName = '') {
  const stamp = '## 项目相对路径';
  const body = String(content || '')
    .replace(/\n## (?:本机绝对路径|项目相对路径)\n[\s\S]*$/u, '')
    .trim();
  const pythonRel = officeDocsVenvPythonRelPath();
  const skillRel = skillName ? `tools/${skillName}` : 'tools/docx、tools/xlsx、tools/pdf 或 tools/pptx';
  return [
    body,
    '',
    stamp,
    '',
    '以下路径均相对 `AI4ES_PROJECT_ROOT`。启动侧车时系统会自动设置该变量；不要写死盘符，不要在会话工作区创建 venv：',
    '',
    `- 本技能源码：\`${skillRel}\``,
    '- Node 模块：`node_modules`（`docx`、`pptxgenjs`）',
    `- Python 解释器：\`${pythonRel}\``,
    '',
    'Windows：`$env:NODE_PATH="$env:AI4ES_PROJECT_ROOT\\node_modules"`；`& "$env:AI4ES_PROJECT_ROOT\\tools\\office-docs-venv\\Scripts\\python.exe"`',
    'Linux：`NODE_PATH="$AI4ES_PROJECT_ROOT/node_modules"`；`"$AI4ES_PROJECT_ROOT/tools/office-docs-venv/bin/python"`'
  ].join('\n');
}

export function stampOfficeDocsSkillMarkdown(skillDir: string) {
  const file = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(file)) return;
  const skillName = path.basename(skillDir);
  const next = annotateOfficeDocsSkillContent(fs.readFileSync(file, 'utf8'), skillName);
  fs.writeFileSync(file, `${next}\n`, 'utf8');
}
