import fs from 'node:fs';
import path from 'node:path';
import { OFFICE_DOCS_SKILLS, stampOfficeDocsSkillMarkdown } from './office-docs-cli';
import { isSystemSkillRemoved, isSystemSkillCustomized } from './skill-removed';

const SHARED_SKILLS_ROOT = path.join(process.cwd(), 'storage', '.opencode', 'skills');
export const OPENCODE_SKILLS_DIR = path.join(process.cwd(), '.opencode', 'skills');

export const CHART_DISCOVERY_SKILL = 'chart-discovery';
export const IMAGE_GENERATION_SKILL = 'image-generation';
export const SELF_LEARNING_SKILL = 'self-learning';
export const MARKITDOWN_SKILL = 'markitdown';
export const OPENALEX_SKILL = 'openalex';
export const DOCX_SKILL = 'docx';
export const PDF_SKILL = 'pdf';
export const XLSX_SKILL = 'xlsx';
export const PPTX_SKILL = 'pptx';
export const TECHNICAL_REPORT_PPT_SKILL = 'technical-report-ppt-pipeline';

/** 须在输入框功能列表选中后才注入；不要同步到 OpenCode skill 目录。 */
export const COMPOSER_GATED_BUNDLED_SKILLS = new Set<string>([CHART_DISCOVERY_SKILL]);

/** 需要出现在 OpenCode `skill` 工具目录里的内置技能。 */
export const OPENCODE_SYNCED_BUNDLED_SKILLS = new Set<string>([
  SELF_LEARNING_SKILL,
  MARKITDOWN_SKILL,
  OPENALEX_SKILL,
  IMAGE_GENERATION_SKILL,
  DOCX_SKILL,
  PDF_SKILL,
  XLSX_SKILL,
  PPTX_SKILL
]);

export const BUNDLED_SKILLS = [
  {
    name: CHART_DISCOVERY_SKILL,
    sourceDir: path.join(process.cwd(), 'tools', 'chart-discovery')
  },
  {
    name: IMAGE_GENERATION_SKILL,
    sourceDir: path.join(process.cwd(), 'tools', 'image-generation')
  },
  {
    name: SELF_LEARNING_SKILL,
    sourceDir: path.join(process.cwd(), 'tools', 'self-learning')
  },
  {
    name: MARKITDOWN_SKILL,
    sourceDir: path.join(process.cwd(), 'tools', 'markitdown')
  },
  {
    name: OPENALEX_SKILL,
    sourceDir: path.join(process.cwd(), 'tools', 'openalex')
  },
  {
    name: DOCX_SKILL,
    sourceDir: path.join(process.cwd(), 'tools', 'docx')
  },
  {
    name: PDF_SKILL,
    sourceDir: path.join(process.cwd(), 'tools', 'pdf')
  },
  {
    name: XLSX_SKILL,
    sourceDir: path.join(process.cwd(), 'tools', 'xlsx')
  },
  {
    name: PPTX_SKILL,
    sourceDir: path.join(process.cwd(), 'tools', 'pptx')
  },
  {
    name: TECHNICAL_REPORT_PPT_SKILL,
    sourceDir: path.join(process.cwd(), '.opencode', 'skills', 'technical-report-ppt-pipeline')
  }
] as const;

function shouldSkip(name: string) {
  return name === '__pycache__' || name === '.venv' || name.startsWith('.') || name.endsWith('.pyc');
}

function copyTree(source: string, target: string) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      const sourceStat = fs.statSync(from);
      const targetStat = fs.statSync(to);
      if (targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
        continue;
      }
    } catch {
      // copy when the destination is missing or unreadable
    }
    fs.copyFileSync(from, to);
  }
}

export function bundledSkillSourceDir(name: string) {
  return BUNDLED_SKILLS.find((skill) => skill.name === name)?.sourceDir;
}

export function bundledSkillMarkdownPath(name: string) {
  const dir = bundledSkillSourceDir(name);
  if (!dir) return null;
  const file = path.join(dir, 'SKILL.md');
  return fs.existsSync(file) ? file : null;
}

function removeSkillDirectory(root: string, name: string) {
  const target = path.join(root, name);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

/** 把技能库展示的内置技能同步到技能目录；出图等可选功能不挂进 skill 工具。 */
export function ensureBundledSkills() {
  const seeded: string[] = [];
  for (const skill of BUNDLED_SKILLS) {
    if (COMPOSER_GATED_BUNDLED_SKILLS.has(skill.name)) {
      removeSkillDirectory(SHARED_SKILLS_ROOT, skill.name);
      removeSkillDirectory(OPENCODE_SKILLS_DIR, skill.name);
      continue;
    }
    if (isSystemSkillRemoved(skill.name) || isSystemSkillCustomized(skill.name)) continue;
    const skillMd = path.join(skill.sourceDir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    if (OFFICE_DOCS_SKILLS.has(skill.name)) {
      removeSkillDirectory(SHARED_SKILLS_ROOT, skill.name);
      removeSkillDirectory(OPENCODE_SKILLS_DIR, skill.name);
    }
    const target = path.join(SHARED_SKILLS_ROOT, skill.name);
    fs.mkdirSync(SHARED_SKILLS_ROOT, { recursive: true });
    copyTree(skill.sourceDir, target);
    if (OFFICE_DOCS_SKILLS.has(skill.name)) stampOfficeDocsSkillMarkdown(target);
    if (OPENCODE_SYNCED_BUNDLED_SKILLS.has(skill.name)) {
      fs.mkdirSync(OPENCODE_SKILLS_DIR, { recursive: true });
      const opencodeTarget = path.join(OPENCODE_SKILLS_DIR, skill.name);
      copyTree(skill.sourceDir, opencodeTarget);
      if (OFFICE_DOCS_SKILLS.has(skill.name)) stampOfficeDocsSkillMarkdown(opencodeTarget);
    }
    seeded.push(skill.name);
  }
  return seeded;
}
