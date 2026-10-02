import {
  COMPOSER_GATED_BUNDLED_SKILLS,
  DOCX_SKILL,
  IMAGE_GENERATION_SKILL,
  MARKITDOWN_SKILL,
  OPENALEX_SKILL,
  PDF_SKILL,
  PPTX_SKILL,
  XLSX_SKILL,
  TECHNICAL_REPORT_PPT_SKILL
} from './bundled-skills';

const SHARED_SKILL_PREFIX = 'shared-';

/**
 * 对话里始终注入正文的辅助技能。目前为空：技能库里的技能由 agent 按需用 skill 加载。
 */
export const ALWAYS_INJECTED_SKILLS = new Set<string>([]);

/**
 * 输入框功能列表选中后才注入正文；不要同步到 OpenCode skill 目录。
 */
export const COMPOSER_GATED_SKILLS = COMPOSER_GATED_BUNDLED_SKILLS;

/** 不出现在技能库，但对话可按附件等条件显式注入正文。 */
export const PROMPT_INJECTABLE_INFRA_SKILLS = new Set<string>([
  MARKITDOWN_SKILL,
  DOCX_SKILL,
  PDF_SKILL,
  XLSX_SKILL,
  PPTX_SKILL
]);

/**
 * 技能库页面展示的系统技能。
 * 专利流水线步骤、页面绑定技能、风格约束、Cursor/Codex 全局技能都不在此列。
 */
export const CATALOG_SYSTEM_SKILLS = new Set<string>([
  IMAGE_GENERATION_SKILL,
  OPENALEX_SKILL,
  'paper-reproduce',
  'esopt',
  'ses-iesp-esopt',
  'mgplan-calculation',
  'nwxs-theoretical-loss-calculation',
  'power-dispatch-optimization',
  'tdmg-acopf-dispatch',
  'pv-wind-load-forecast',
  TECHNICAL_REPORT_PPT_SKILL
]);

export function isSharedSkillName(name: string) {
  return String(name || '').startsWith(SHARED_SKILL_PREFIX);
}

/** 技能库是否展示该技能。 */
export function isCatalogSkill(skill: { name: string; source?: string | null }) {
  const name = String(skill.name || '').trim();
  if (!name) return false;
  if (skill.source === 'shared' || isSharedSkillName(name)) return true;
  return CATALOG_SYSTEM_SKILLS.has(name);
}

/** 本轮对话是否把该技能正文自动注入提示。技能库技能不自动注入。 */
export function shouldLoadSkillForConversation(name: string) {
  const key = String(name || '').trim();
  if (!key) return false;
  if (COMPOSER_GATED_SKILLS.has(key)) return false;
  return ALWAYS_INJECTED_SKILLS.has(key);
}

/** 调用方显式点名时是否允许注入（含输入框功能列表选中后的出图技能）。 */
export function canLoadSkillWhenRequested(name: string) {
  const key = String(name || '').trim();
  if (!key) return false;
  if (COMPOSER_GATED_SKILLS.has(key)) return true;
  if (PROMPT_INJECTABLE_INFRA_SKILLS.has(key)) return true;
  return shouldLoadSkillForConversation(key);
}
