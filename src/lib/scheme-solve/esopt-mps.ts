import fs from 'node:fs';
import path from 'node:path';
import { listChatAttachmentRows, type ChatAttachmentRow } from '@/lib/chat-attachments';
import { isMathProgExtension } from '@/lib/attachments/math-prog';
import { classifyModelSpec, type ParsedModel } from './model-json';
import type { SchemeIdea } from './types';
import { schemeIdeaDirectory, writeWorkspaceText } from './workspace';

export const ESOPT_MATH_PROG_EXTENSIONS = new Set(['.mps', '.lp']);

export function isEsoptProblemClass(value?: string | null) {
  return value === 'dcopf' || value === 'lp' || value === 'mip' || !value;
}

export function esoptModelDir(sessionId: string, ideaId: string) {
  return path.join(schemeIdeaDirectory(sessionId, ideaId), 'esopt');
}

function isEsoptModelAttachment(row: ChatAttachmentRow) {
  const ext = String(row.extension || path.extname(row.original_name || '')).toLowerCase();
  return isMathProgExtension(ext) && fs.existsSync(row.storage_path);
}

export async function findEsoptModelAttachment(sessionId: string) {
  const rows = await listChatAttachmentRows(sessionId);
  return rows.find(isEsoptModelAttachment) || null;
}

export function writeEsoptMpsModelJson(
  sessionId: string,
  ideaId: string,
  spec: { modelFile: string; mode?: 'mps' | 'lp'; sourceName?: string }
) {
  const mode = spec.mode || (spec.modelFile.toLowerCase().endsWith('.lp') ? 'lp' : 'mps');
  const payload = {
    engine: 'esopt',
    mode,
    modelFile: spec.modelFile.replace(/\\/g, '/'),
    source: 'attachment',
    sourceName: spec.sourceName || path.basename(spec.modelFile)
  };
  writeWorkspaceText(sessionId, ideaId, 'model.json', `${JSON.stringify(payload, null, 2)}\n`);
  return classifyModelSpec(payload);
}

export async function prepareEsoptMpsWorkspace(
  sessionId: string,
  idea: SchemeIdea
): Promise<ParsedModel | null> {
  if (!isEsoptProblemClass(idea.problemClass)) return null;
  const attachment = await findEsoptModelAttachment(sessionId);
  if (!attachment) return null;

  const ext = String(attachment.extension || path.extname(attachment.original_name)).toLowerCase();
  const destName = path.basename(attachment.original_name || `model${ext}`);
  const dest = path.join(esoptModelDir(sessionId, idea.id), destName);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(attachment.storage_path, dest);

  return writeEsoptMpsModelJson(sessionId, idea.id, {
    modelFile: path.posix.join('esopt', destName),
    mode: ext === '.lp' ? 'lp' : 'mps',
    sourceName: attachment.original_name
  });
}

export function resolveEsoptModelFile(sessionId: string, ideaId: string, spec: Record<string, unknown> | null) {
  const relative = String(spec?.modelFile || spec?.modelPath || '').trim();
  if (!relative) return '';
  const candidate = path.resolve(schemeIdeaDirectory(sessionId, ideaId), relative);
  const root = schemeIdeaDirectory(sessionId, ideaId);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('ESOPT 模型路径必须位于当前想法工作区内。');
  }
  return candidate;
}
