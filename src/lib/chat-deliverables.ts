import fs from 'node:fs';
import path from 'node:path';
import { storeChatAttachment, bindChatAttachmentsToMessage, type ChatAttachment } from './chat-attachments';
import { chatWorkspacesRoot, conversationChartAliases } from './chat-generated-charts';

/**
 * Files in these folders are explicitly user-facing output locations.  The
 * agent is told to use `deliverables/`; `charts/` remains supported for the
 * chart skill and legacy sessions.
 */
const DELIVERABLE_DIRS = ['deliverables', 'charts'];
const MANIFEST_FILES = [
  path.join('deliverables', 'manifest.json'),
  path.join('.ai4es', 'deliverables.json'),
  'deliverables.json',
  path.join('charts', 'manifest.json')
];
const MAX_FILES = 100;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const INTERNAL_NAMES = new Set([
  'manifest.json',
  'deliverables.json',
  'progress.json',
  'status.json',
  'package-lock.json',
  'node_modules'
]);
const CHART_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

type ManifestEntry = { path: string; title?: string; description?: string };

export type AgentDeliverableHarvestOptions = {
  /** The final public answer is used only to resolve paths the agent named. */
  answer?: string;
  /** Files explicitly listed in a manifest are accepted regardless of mtime. */
  startedAtMs?: number;
  /** Chart harvesting owns charts/ during chart-enabled turns. */
  includeCharts?: boolean;
};

type Candidate = ManifestEntry & { absolutePath: string; relativePath: string };

function workspacePaths(conversationId: string) {
  const root = chatWorkspacesRoot();
  const aliases = new Set(conversationChartAliases(conversationId));
  // Older runs used compact and hashed conversation directory names. Include
  // them for recovery while keeping the canonical path first for new turns.
  if (fs.existsSync(root)) {
    const compact = conversationId.replace(/-/g, '');
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.replace(/-/g, '') === compact) aliases.add(entry.name);
    }
  }
  return [...aliases].map((alias) => path.join(root, alias));
}

function isInside(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function normalizeRelative(value: unknown) {
  let text = String(value || '').trim().replace(/\\/g, '/');
  text = text.replace(/^\.\//, '');
  const marker = '/storage/chat-workspaces/';
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    const after = text.slice(markerIndex + marker.length);
    const slash = after.indexOf('/');
    text = slash >= 0 ? after.slice(slash + 1) : '';
  }
  if (text.startsWith('storage/chat-workspaces/')) {
    const parts = text.split('/');
    text = parts.length > 3 ? parts.slice(3).join('/') : '';
  }
  return text.replace(/^\/+/, '');
}

function safeFileName(filePath: string) {
  const name = path.basename(filePath).trim();
  return name && name !== '.' && name !== '..' ? name : 'attachment';
}

function walkFiles(directory: string, depth = 0): string[] {
  if (depth > 8 || !fs.existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules'
      || entry.name === '.git'
      || (entry.name.startsWith('.') && entry.name !== '.ai4es')
    ) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(absolute, depth + 1));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

function readManifest(filePath: string): ManifestEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? ((parsed as { files?: unknown; deliverables?: unknown }).files
          || (parsed as { deliverables?: unknown }).deliverables
          || [])
        : [];
    if (!Array.isArray(values)) return [];
    return values.flatMap((value): ManifestEntry[] => {
      if (typeof value === 'string') return [{ path: value }];
      if (!value || typeof value !== 'object') return [];
      const entry = value as { file?: unknown; path?: unknown; name?: unknown; title?: unknown; description?: unknown; deliver?: unknown };
      if (entry.deliver === false) return [];
      const file = entry.file || entry.path || entry.name;
      const relative = normalizeRelative(file);
      return relative
        ? [{ path: relative, title: String(entry.title || '').trim() || undefined, description: String(entry.description || '').trim() || undefined }]
        : [];
    });
  } catch {
    return [];
  }
}

function answerPaths(answer: string | undefined) {
  if (!answer) return [] as string[];
  const found = new Set<string>();
  // Accept paths the agent cites in either code spans or ordinary prose. The
  // containment check below prevents a citation from escaping the workspace.
  const pattern = /(?:storage\/chat-workspaces\/[^\s`"'<>]+\/)?(?:deliverables|charts|repro|outputs|results)\/[^\s`"'<>，。；：]+/gi;
  for (const match of answer.matchAll(pattern)) {
    const relative = normalizeRelative(match[0].replace(/[),.;:!?\]}]+$/g, ''));
    if (relative) found.add(relative);
  }
  return [...found];
}

function answerFileNames(answer: string | undefined) {
  if (!answer) return [] as string[];
  const found = new Set<string>();
  // Filename-only fallback is deliberately limited to user-facing document,
  // data, and image formats. Scripts and experiment internals are often
  // mentioned for verification but are not delivery files unless placed in a
  // dedicated deliverables/ or explicitly named output path.
  const extension = '(?:pdf|docx?|pptx?|xlsx?|csv|tsv|json|md|markdown|txt|html?|xml|ya?ml|zip|png|jpe?g|gif|webp|svg|mps|lp|mat|parquet|feather|npy|npz|pkl|pickle|bin|dat)';
  const internalName = /^(?:manifest|deliverables|progress|status)(?:[-_.]|$)|^spec(?:[-_.]|$)/i;
  const deliveryContext = (index: number, length: number) => {
    const context = answer.slice(Math.max(0, index - 90), index + length + 90);
    if (/(?:上传|输入|原文|脚本|代码|spec|manifest|清单|核验)/iu.test(context)) return false;
    return /(?:生成|完成|成品|交付|输出|下载|报告|结果|保存|落盘|附件|写入)/iu.test(context);
  };
  const pattern = new RegExp(`\\b[A-Za-z0-9][A-Za-z0-9._-]{0,120}\\.${extension}\\b`, 'gi');
  for (const match of answer.matchAll(pattern)) {
    const value = String(match[0] || '').trim();
    if (value && !internalName.test(value) && deliveryContext(match.index ?? 0, value.length)) {
      found.add(value.toLowerCase());
    }
  }
  for (const match of answer.matchAll(/`([^`]+)`/g)) {
    const value = String(match[1] || '').trim().replace(/\\/g, '/').split('/').pop() || '';
    if (
      new RegExp(`\\.${extension}$`, 'i').test(value)
      && !internalName.test(value)
      && deliveryContext(match.index ?? 0, match[0].length)
    ) found.add(value.toLowerCase());
  }
  return [...found];
}

function addCandidate(
  candidates: Map<string, Candidate>,
  root: string,
  relativePath: string,
  entry: Partial<ManifestEntry> = {},
  options: AgentDeliverableHarvestOptions = {},
  explicit = false
) {
  const relative = normalizeRelative(relativePath);
  if (!relative || relative.startsWith('knowledge-corpus/')) return;
  const absolute = path.resolve(root, relative);
  if (!isInside(root, absolute) || !fs.existsSync(absolute)) return;
  let stat: fs.Stats;
  try {
    const realRoot = fs.realpathSync(root);
    const realPath = fs.realpathSync(absolute);
    if (!isInside(realRoot, realPath)) return;
    stat = fs.statSync(absolute);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) return;
  const base = safeFileName(absolute).toLowerCase();
  if (INTERNAL_NAMES.has(base) || base === 'plan.md') return;
  if (path.extname(base) === '.json' && /^spec(?:[-_.]|$)/i.test(base)) return;
  if (!explicit && options.startedAtMs != null && stat.mtimeMs + 1000 < options.startedAtMs) return;
  const key = absolute.toLowerCase();
  if (candidates.has(key)) return;
  candidates.set(key, {
    path: relative,
    title: entry.title,
    description: entry.description,
    absolutePath: absolute,
    relativePath: relative
  });
}

function collectCandidates(conversationId: string, options: AgentDeliverableHarvestOptions) {
  const candidates = new Map<string, Candidate>();
  for (const root of workspacePaths(conversationId)) {
    const manifests = MANIFEST_FILES
      .map((relative) => path.join(root, relative))
      .filter((filePath) => fs.existsSync(filePath));

    for (const manifestPath of manifests) {
      const manifestRelativePath = path.relative(root, manifestPath).replace(/\\/g, '/').toLowerCase();
      if (options.includeCharts === false && manifestRelativePath.startsWith('charts/')) continue;
      const manifestDir = path.dirname(path.relative(root, manifestPath));
      for (const entry of readManifest(manifestPath)) {
        // Support both conventions used by agents: paths relative to the
        // manifest and paths relative to the conversation workspace root.
        const manifestRelative = manifestDir === '.'
          ? entry.path
          : path.posix.join(manifestDir.replace(/\\/g, '/'), entry.path);
        addCandidate(candidates, root, manifestRelative, entry, options, true);
        if (manifestRelative !== entry.path) {
          addCandidate(candidates, root, entry.path, entry, options, true);
        }
      }
    }

    const directories = options.includeCharts === false ? ['deliverables'] : DELIVERABLE_DIRS;
    for (const directory of directories) {
      const absoluteDir = path.join(root, directory);
      for (const filePath of walkFiles(absoluteDir)) {
        const relative = path.relative(root, filePath).replace(/\\/g, '/');
        const base = path.basename(filePath).toLowerCase();
        if (base === 'manifest.json') continue;
        if (directory === 'charts' && !CHART_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
        // A live turn uses mtime to avoid rebinding an older persistent file;
        // recovery mode (no startedAtMs) scans the whole deliverables folder.
        addCandidate(
          candidates,
          root,
          relative,
          {},
          options,
          directory === 'deliverables' && options.startedAtMs == null
        );
      }
    }

    for (const relative of answerPaths(options.answer)) {
      addCandidate(candidates, root, relative, {}, options, true);
    }

    const namedFiles = new Set(answerFileNames(options.answer));
    if (namedFiles.size) {
      for (const filePath of walkFiles(root)) {
        if (!namedFiles.has(path.basename(filePath).toLowerCase())) continue;
        const relative = path.relative(root, filePath).replace(/\\/g, '/');
        addCandidate(candidates, root, relative, {}, options, true);
      }
    }
  }

  return [...candidates.values()].slice(0, MAX_FILES);
}

function mediaTypeFor(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  const types: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'application/xml',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip'
  };
  return types[extension] || 'application/octet-stream';
}

/**
 * Import the files the Agent deliberately exposed into the normal attachment
 * table and bind them to the assistant message. This makes history, the side
 * rail, preview and download all use one authoritative data path.
 */
export async function harvestAgentDeliverables(
  conversationId: string,
  messageId: string,
  options: AgentDeliverableHarvestOptions = {}
): Promise<ChatAttachment[]> {
  const candidates = collectCandidates(conversationId, options);
  if (!candidates.length) return [];
  const attachments: ChatAttachment[] = [];
  for (const candidate of candidates) {
    try {
      const stored = await storeChatAttachment(
        conversationId,
        {
          name: safeFileName(candidate.absolutePath),
          type: mediaTypeFor(candidate.absolutePath),
          buffer: fs.readFileSync(candidate.absolutePath)
        },
        {
          allowAnyExtension: true,
          deferToAgent: false,
          extraMetadata: {
            role: 'agent-deliverable',
            sourcePath: candidate.relativePath,
            ...(candidate.title ? { deliveryTitle: candidate.title } : {}),
            ...(candidate.description ? { deliveryDescription: candidate.description } : {})
          }
        }
      );
      // A persistent deliverables directory is intentional, but an old file
      // must not be re-bound to every later assistant turn. It remains visible
      // through its original message and the conversation-level side rail.
      if (stored.deduplicated && stored.attachment.messageId && stored.attachment.messageId !== messageId) {
        continue;
      }
      attachments.push(stored.attachment);
    } catch (error) {
      console.error('[chat] store agent deliverable failed', candidate.absolutePath, error);
    }
  }
  if (!attachments.length) return [];
  return bindChatAttachmentsToMessage(
    conversationId,
    messageId,
    attachments.map((attachment) => attachment.id)
  );
}
