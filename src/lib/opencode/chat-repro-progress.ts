import fs from 'node:fs';
import path from 'node:path';
import { chatWorkspacesRoot } from '../chat-generated-charts';
import type { ChatReproProgress } from './chat-repro-types';

export type { ChatReproProgress, ChatReproStage, ChatReproStageStatus } from './chat-repro-types';

export function chatReproRoot(conversationId: string, slug = 'current') {
  return path.join(chatWorkspacesRoot(), conversationId, 'repro', slug);
}

export function chatReproProgressPath(conversationId: string, slug = 'current') {
  return path.join(chatReproRoot(conversationId, slug), 'progress.json');
}

export function chatReproPlanPath(conversationId: string, slug = 'current') {
  return path.join(chatReproRoot(conversationId, slug), 'PLAN.md');
}

export function emptyChatReproProgress(slug = 'current', title?: string): ChatReproProgress {
  return {
    version: 1,
    slug,
    title,
    stages: [],
    updatedAt: new Date().toISOString()
  };
}

export function readChatReproProgress(conversationId: string, slug = 'current'): ChatReproProgress | null {
  const file = chatReproProgressPath(conversationId, slug);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ChatReproProgress;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.stages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeChatReproProgress(conversationId: string, progress: ChatReproProgress) {
  const file = chatReproProgressPath(conversationId, progress.slug || 'current');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...progress, version: 1 as const, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export function listChatReproProgress(conversationId: string): ChatReproProgress[] {
  const root = path.join(chatWorkspacesRoot(), conversationId, 'repro');
  if (!fs.existsSync(root)) return [];
  const items: ChatReproProgress[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const progress = readChatReproProgress(conversationId, entry.name);
    if (progress) items.push(progress);
  }
  return items;
}
