import fs from 'node:fs';
import path from 'node:path';
import { conversationAttachmentCacheDir } from '@/lib/attachments/workspace-cache';
import { deleteConversationAttachments } from '@/lib/chat-attachments';
import { chatWorkspacesRoot, conversationChartAliases } from '@/lib/chat-generated-charts';
import { getCorpusRoot } from '@/lib/corpus/schema';
import { all, get } from '@/lib/db';

export const DEFAULT_CHAT_WORKSPACE_RETENTION_DAYS = 7;
const STATE_FILE = path.join(process.cwd(), 'storage', 'chat-workspace-retention.json');
const LOCK_FILE = path.join(process.cwd(), 'storage', 'chat-workspace-retention.lock');
const SCHEDULER_KEY = '__ai4esChatWorkspaceRetention';
const MIN_INTERVAL_MS = 60_000;

type ConversationRow = {
  id: string;
  kind: string | null;
  updated_at: string;
};

export type PurgeChatWorkspaceOptions = {
  now?: number;
  retentionMs?: number;
  /** Skip last-run throttle (tests / manual). */
  force?: boolean;
  /** Limit purge to these conversation IDs so tests cannot touch other sessions. */
  conversationIds?: string[];
};

export type PurgeChatWorkspaceResult = {
  skipped?: boolean;
  retentionDays: number;
  conversations: number;
  workspaces: number;
  attachments: number;
  corpusCaches: number;
};

type SchedulerState = {
  started: boolean;
  timer?: ReturnType<typeof setInterval>;
};

function schedulerState() {
  const g = globalThis as typeof globalThis & { [SCHEDULER_KEY]?: SchedulerState };
  if (!g[SCHEDULER_KEY]) g[SCHEDULER_KEY] = { started: false };
  return g[SCHEDULER_KEY]!;
}

export function chatWorkspaceRetentionDays() {
  const raw = Number(process.env.CHAT_WORKSPACE_RETENTION_DAYS || DEFAULT_CHAT_WORKSPACE_RETENTION_DAYS);
  if (!Number.isFinite(raw)) return DEFAULT_CHAT_WORKSPACE_RETENTION_DAYS;
  return Math.max(1, Math.min(3650, Math.floor(raw)));
}

export function chatWorkspaceRetentionMs() {
  return chatWorkspaceRetentionDays() * 24 * 60 * 60 * 1000;
}

function normalizePath(value: string) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string) {
  const resolvedRoot = normalizePath(root);
  const resolved = normalizePath(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function parseTimestamp(value: string) {
  const text = String(value || '').trim();
  if (!text) return Number.NaN;
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;
  return Date.parse(text.replace(' ', 'T'));
}

function isStaleTimestamp(value: string, now: number, retentionMs: number) {
  const parsed = parseTimestamp(value);
  if (!Number.isFinite(parsed)) return false;
  return now - parsed >= retentionMs;
}

function newestActivityMs(directory: string, workspaceRoot: string) {
  let newest = 0;
  const visit = (target: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (isExternalLink(target, workspaceRoot, stat)) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(target);
    } catch {
      return;
    }
    for (const name of names) visit(path.join(target, name));
  };
  visit(directory);
  return newest;
}

function isExternalLink(target: string, workspaceRoot: string, stat?: fs.Stats) {
  let info = stat;
  try {
    info = info || fs.lstatSync(target);
  } catch {
    return false;
  }
  if (info.isSymbolicLink()) {
    try {
      return !isInside(workspaceRoot, fs.realpathSync(target));
    } catch {
      return true;
    }
  }
  if (!info.isDirectory()) return false;
  try {
    const real = fs.realpathSync(target);
    const resolved = path.resolve(target);
    if (normalizePath(real) === normalizePath(resolved)) return false;
    return !isInside(workspaceRoot, real);
  } catch {
    return false;
  }
}

function removeReparsePoint(target: string) {
  try {
    fs.unlinkSync(target);
    return;
  } catch {
    // Windows junctions often need rmdir rather than unlink.
  }
  fs.rmdirSync(target);
}

/** Delete a workspace tree without following junctions/symlinks that point outside it. */
export function removeWorkspaceTree(directory: string) {
  const workspaceRoot = path.resolve(chatWorkspacesRoot());
  const target = path.resolve(directory);
  if (!isInside(workspaceRoot, target) || normalizePath(target) === normalizePath(workspaceRoot)) {
    return false;
  }
  if (!fs.existsSync(target)) return false;

  const visit = (current: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return;
    }
    if (isExternalLink(current, workspaceRoot, stat)) {
      removeReparsePoint(current);
      return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fs.unlinkSync(current);
      return;
    }
    for (const name of fs.readdirSync(current)) {
      visit(path.join(current, name));
    }
    fs.rmdirSync(current);
  };

  visit(target);
  return !fs.existsSync(target);
}

function workspaceDirsFor(conversationId: string) {
  const root = chatWorkspacesRoot();
  const names = new Set(conversationChartAliases(conversationId));
  if (fs.existsSync(root)) {
    const compact = conversationId.replace(/-/g, '');
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (names.has(entry.name) || entry.name.replace(/-/g, '') === compact) {
        names.add(entry.name);
      }
    }
  }
  return [...names].map((name) => path.join(root, name));
}

function removeCorpusAttachmentCache(conversationId: string) {
  const cacheDir = path.resolve(conversationAttachmentCacheDir(conversationId));
  const expectedParent = path.resolve(path.join(getCorpusRoot(), 'attachments'));
  if (!isInside(expectedParent, cacheDir) || normalizePath(cacheDir) === normalizePath(expectedParent)) {
    return false;
  }
  if (!fs.existsSync(cacheDir)) return false;
  fs.rmSync(cacheDir, { recursive: true, force: true });
  return !fs.existsSync(cacheDir);
}

/** Remove isolated chat workspace dirs and the virtual attachment cache. Conversation rows stay. */
export function removeChatWorkspace(conversationId: string) {
  const directories: string[] = [];
  for (const directory of workspaceDirsFor(conversationId)) {
    if (removeWorkspaceTree(directory)) directories.push(directory);
  }
  const corpusCache = removeCorpusAttachmentCache(conversationId);
  return { directories, corpusCache };
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { at?: number };
    return Number(parsed.at) || 0;
  } catch {
    return 0;
  }
}

function writeState(result: PurgeChatWorkspaceResult) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ at: Date.now(), pid: process.pid, result }, null, 2),
    'utf8'
  );
}

function acquireLock(force = false) {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
    return true;
  } catch {
    try {
      const prev = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as { at?: number };
      const age = Date.now() - Number(prev.at || 0);
      if (!force && Number.isFinite(age) && age < 30 * 60 * 1000) return false;
      fs.unlinkSync(LOCK_FILE);
    } catch {
      if (!force) return false;
    }
    try {
      fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
      return true;
    } catch {
      return force;
    }
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

function aliasNamesFor(conversationId: string) {
  const names = new Set(conversationChartAliases(conversationId));
  names.add(conversationId.replace(/-/g, ''));
  return names;
}

async function attachmentCount(conversationId: string) {
  const row = await get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM chat_attachments WHERE conversation_id = ?',
    [conversationId]
  );
  return Number(row?.n || 0);
}

/**
 * After 7 days of inactivity, drop chat attachments and workspace files.
 * Conversation rows and message text are kept.
 */
export async function purgeExpiredChatWorkspaceContent(
  options: PurgeChatWorkspaceOptions = {}
): Promise<PurgeChatWorkspaceResult> {
  const retentionMs = options.retentionMs ?? chatWorkspaceRetentionMs();
  const retentionDays = Math.max(1, Math.round(retentionMs / (24 * 60 * 60 * 1000)));
  const now = options.now ?? Date.now();
  const empty: PurgeChatWorkspaceResult = {
    skipped: true,
    retentionDays,
    conversations: 0,
    workspaces: 0,
    attachments: 0,
    corpusCaches: 0
  };

  if (!options.force) {
    const last = readState();
    const configured = Number(process.env.CHAT_WORKSPACE_RETENTION_INTERVAL_MS || 60 * 60 * 1000);
    const minGap = Math.max(MIN_INTERVAL_MS, Math.floor((Number.isFinite(configured) ? configured : 60 * 60 * 1000) / 2));
    if (last && now - last < minGap) return empty;
  }
  if (!acquireLock(Boolean(options.force))) return empty;

  const result: PurgeChatWorkspaceResult = {
    retentionDays,
    conversations: 0,
    workspaces: 0,
    attachments: 0,
    corpusCaches: 0
  };

  try {
    const scopedIds = (options.conversationIds || [])
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    const conversations = scopedIds.length
      ? await all<ConversationRow>(
          `SELECT id, kind, updated_at FROM chat_conversations
           WHERE id IN (${scopedIds.map(() => '?').join(', ')})`,
          scopedIds
        )
      : await all<ConversationRow>('SELECT id, kind, updated_at FROM chat_conversations');
    const protectedNames = new Set<string>();
    const staleNames = new Set<string>();
    const staleChatIds: string[] = [];

    for (const row of conversations) {
      const kind = row.kind === 'research-review' ? 'research-review' : 'chat';
      const stale = isStaleTimestamp(row.updated_at, now, retentionMs);
      if (kind === 'chat' && stale) {
        staleChatIds.push(row.id);
        for (const name of aliasNamesFor(row.id)) staleNames.add(name);
        continue;
      }
      for (const name of aliasNamesFor(row.id)) protectedNames.add(name);
    }

    for (const conversationId of staleChatIds) {
      const files = await attachmentCount(conversationId);
      await deleteConversationAttachments(conversationId);
      const removed = removeChatWorkspace(conversationId);
      result.conversations += 1;
      result.attachments += files;
      result.workspaces += removed.directories.length;
      if (removed.corpusCache) result.corpusCaches += 1;
    }

    const root = chatWorkspacesRoot();
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (protectedNames.has(entry.name)) continue;
        const directory = path.join(root, entry.name);
        if (!isInside(root, directory) || normalizePath(directory) === normalizePath(root)) continue;
        if (scopedIds.length && !staleNames.has(entry.name) && !scopedIds.includes(entry.name)) {
          continue;
        }
        if (!staleNames.has(entry.name)) {
          const activity = newestActivityMs(directory, path.resolve(root));
          if (activity && now - activity < retentionMs) continue;
        }
        if (removeWorkspaceTree(directory)) result.workspaces += 1;
      }
    }

    writeState(result);
    if (result.conversations || result.workspaces || result.attachments) {
      console.log(
        `[chat-workspace-retention] purged conversations=${result.conversations} workspaces=${result.workspaces} attachments=${result.attachments}`
      );
    }
    return result;
  } finally {
    releaseLock();
  }
}

export function startChatWorkspaceRetentionScheduler() {
  const state = schedulerState();
  if (state.started) return;
  state.started = true;
  const delay = Math.max(0, Number(process.env.CHAT_WORKSPACE_RETENTION_START_DELAY_MS || 20_000) || 20_000);
  const interval = Math.max(
    MIN_INTERVAL_MS,
    Number(process.env.CHAT_WORKSPACE_RETENTION_INTERVAL_MS || 60 * 60 * 1000) || 60 * 60 * 1000
  );
  const run = () => {
    void purgeExpiredChatWorkspaceContent().catch((error) => {
      console.error('[chat-workspace-retention] purge failed', error);
    });
  };
  const boot = setTimeout(run, delay);
  if (typeof boot.unref === 'function') boot.unref();
  state.timer = setInterval(run, interval);
  if (typeof state.timer.unref === 'function') state.timer.unref();
}
