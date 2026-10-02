import fs from 'node:fs';
import path from 'node:path';
import { listChatAttachmentRows, type ChatAttachmentRow } from '@/lib/chat-attachments';
import {
  resolveBuiltinCaseFile,
  TDMG_BUILTIN_CASES,
  TDMG_DEFAULT_CASE,
  TDMG_ENGINE
} from './tdmg';
import type { SchemeIdea } from './types';
import { schemeIdeaDirectory, writeWorkspaceText } from './workspace';

export const TDMG_CASE_EXTENSIONS = new Set(['.m', '.mat', '.py', '.json']);

export function tdmgInputDir(sessionId: string, ideaId: string) {
  return path.join(schemeIdeaDirectory(sessionId, ideaId), 'tdmg', 'input');
}

export function tdmgOutputDir(sessionId: string, ideaId: string) {
  return path.join(schemeIdeaDirectory(sessionId, ideaId), 'tdmg', 'output');
}

export function normalizeTdmgCaseName(value?: string | null) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'custom') return '';
  const base = path.basename(raw).replace(/\.(m|mat|py|json)$/i, '');
  return base.replace(/^pglib_opf_/i, '');
}

export function inferTdmgCase(text?: string | null) {
  const value = String(text || '').toLowerCase();
  if (/case300|ieee\s*300|300\s*节点|300-bus/.test(value)) return 'case300';
  if (/case118|ieee\s*118|118\s*节点|118-bus/.test(value)) return 'case118';
  if (/case57|ieee\s*57|57\s*节点|57-bus/.test(value)) return 'case57';
  if (/case39|ieee\s*39|39\s*节点|39-bus|new england/.test(value)) return 'case39';
  if (/case30|ieee\s*30|30\s*节点|30-bus/.test(value)) return 'case30';
  if (/case24|ieee\s*24|24\s*节点|24-bus|rts-?24/.test(value)) return 'case24';
  if (/case14|ieee\s*14|14\s*节点|14-bus/.test(value)) return 'case14';
  if (/case9|ieee\s*9|9\s*节点|9-bus/.test(value)) return 'case9';
  const normalized = normalizeTdmgCaseName(value);
  if (normalized && TDMG_BUILTIN_CASES[normalized.toLowerCase()]) return normalized.toLowerCase();
  return TDMG_DEFAULT_CASE;
}

export function looksModularTdmg(idea: Pick<SchemeIdea, 'title' | 'summary' | 'decisions' | 'limits' | 'goal' | 'caseHint'>) {
  const text = `${idea.title} ${idea.summary} ${idea.decisions} ${idea.limits} ${idea.goal} ${idea.caseHint || ''}`;
  return /输配微|日前|日内|实时|储能|SOC|柔性负荷|多时段|tdm\b|分层调度/i.test(text);
}

export function wantsTdmgProfiles(idea: Pick<SchemeIdea, 'title' | 'summary' | 'decisions' | 'limits' | 'goal' | 'caseHint'>) {
  const text = `${idea.title} ${idea.summary} ${idea.decisions} ${idea.limits} ${idea.goal} ${idea.caseHint || ''}`;
  return /负荷曲线|profiles|逐时|24\s*小时|24h/i.test(text) && !looksModularTdmg(idea);
}

export function writeTdmgLoadProfiles(filePath: string, hours = 24) {
  const curve = [0.72, 0.68, 0.65, 0.7, 0.78, 0.88, 0.95, 1, 0.97, 0.93, 0.9, 0.88, 0.86, 0.85, 0.87, 0.92, 0.98, 1.02, 1, 0.94, 0.88, 0.82, 0.78, 0.74];
  const periods = Array.from({ length: Math.max(1, hours) }, (_, index) => ({
    name: `t${String(index + 1).padStart(2, '0')}`,
    load_scale: curve[index % curve.length]
  }));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ periods }, null, 2)}\n`, 'utf8');
  return filePath;
}

function isCaseAttachment(row: ChatAttachmentRow) {
  const ext = String(row.extension || path.extname(row.original_name || '')).toLowerCase();
  if (!TDMG_CASE_EXTENSIONS.has(ext)) return false;
  if (ext === '.json') {
    return /case|mpc|matpower|tdmg|scenario/i.test(row.original_name);
  }
  return true;
}

export async function findTdmgCaseAttachment(sessionId: string) {
  const rows = await listChatAttachmentRows(sessionId);
  return rows.find((row) => isCaseAttachment(row) && fs.existsSync(row.storage_path)) || null;
}

export function writeTdmgModelJson(
  sessionId: string,
  ideaId: string,
  spec?: { case?: string; mode?: 'snapshot' | 'scenario' }
) {
  writeWorkspaceText(
    sessionId,
    ideaId,
    'model.json',
    `${JSON.stringify({
      engine: TDMG_ENGINE,
      case: spec?.case || TDMG_DEFAULT_CASE,
      mode: spec?.mode || 'snapshot',
      configDir: 'tdmg/input'
    }, null, 2)}\n`
  );
}

function copyFile(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

export async function prepareTdmgWorkspace(
  sessionId: string,
  idea: SchemeIdea,
  options?: { caseHint?: string }
) {
  const inputDir = tdmgInputDir(sessionId, idea.id);
  const outputDir = tdmgOutputDir(sessionId, idea.id);
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const attachment = await findTdmgCaseAttachment(sessionId);
  const hinted = normalizeTdmgCaseName(options?.caseHint || idea.caseHint);
  const inferred = inferTdmgCase(`${options?.caseHint || ''} ${idea.caseHint || ''} ${idea.title} ${idea.summary}`);
  let caseName = (hinted && hinted !== TDMG_DEFAULT_CASE ? hinted : inferred) || TDMG_DEFAULT_CASE;
  let casePath = '';
  let source: 'attachment' | 'builtin' = 'builtin';

  if (attachment) {
    const dest = path.join(inputDir, path.basename(attachment.original_name));
    copyFile(attachment.storage_path, dest);
    casePath = dest;
    caseName = normalizeTdmgCaseName(attachment.original_name) || caseName;
    source = 'attachment';
  } else {
    const builtin = resolveBuiltinCaseFile(caseName) || resolveBuiltinCaseFile(TDMG_DEFAULT_CASE);
    if (!builtin) {
      throw new Error(`未找到内置算例 ${caseName}。请上传 .m/.mat 算例，或解压离线包的 _vendor。`);
    }
    const dest = path.join(inputDir, path.basename(builtin));
    copyFile(builtin, dest);
    casePath = dest;
    caseName = normalizeTdmgCaseName(path.basename(builtin)) || TDMG_DEFAULT_CASE;
  }

  const mode = looksModularTdmg(idea) ? 'scenario' : 'snapshot';
  writeTdmgModelJson(sessionId, idea.id, { case: caseName, mode });
  return { inputDir, outputDir, casePath, caseName, source, mode };
}

export function hasTdmgOutput(outputDir: string) {
  return fs.existsSync(path.join(outputDir, 'summary.json'))
    || fs.existsSync(path.join(outputDir, 'portfolio_summary.json'))
    || fs.existsSync(path.join(outputDir, 'results', 'summary.json'))
    || fs.existsSync(path.join(outputDir, 'results', 'portfolio_summary.json'));
}

export function listTdmgOutputFiles(outputDir: string) {
  if (!fs.existsSync(outputDir)) return [];
  const names: string[] = [];
  const walk = (dir: string, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else names.push(rel);
    }
  };
  walk(outputDir);
  return names;
}
