import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  bindChatAttachmentsToMessage,
  storeChatAttachment,
  type ChatAttachment
} from './chat-attachments';
import { getCorpusRoot } from './corpus/schema';

export const GENERATED_CHART_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg'
]);

const MAX_CHARTS_PER_TURN = 8;
const SPEC_NAME_RE = /(?:^spec[-_].+\.json$|\.spec\.json$|^chart[-_].+\.json$)/i;

export function chatWorkspacesRoot() {
  return path.join(process.cwd(), 'storage', 'chat-workspaces');
}

export function chatChartOutputDir(conversationId: string) {
  return path.join(chatWorkspacesRoot(), conversationId, 'charts');
}

export function chatChartOutputRelative(conversationId: string) {
  return path.posix.join('storage', 'chat-workspaces', conversationId, 'charts');
}

export function conversationChartAliases(conversationId: string) {
  return [
    conversationId,
    conversationId.replace(/-/g, ''),
    crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 24)
  ];
}

export function ensureChatChartOutputDir(conversationId: string) {
  const directory = chatChartOutputDir(conversationId);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function ensureJunction(linkPath: string, targetPath: string) {
  if (fs.existsSync(linkPath) || !fs.existsSync(targetPath)) return;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(targetPath, linkPath, 'junction');
  } catch {
    // Non-fatal: corpus-guard still rewrites knowledge-corpus/ to ../../knowledge-corpus/.
  }
}

/** 会话隔离目录：charts/ 可写，knowledge-corpus/ 挂到真实语料，read 相对路径即可。 */
export function ensureChatWorkspace(conversationId: string) {
  const root = path.join(chatWorkspacesRoot(), conversationId);
  fs.mkdirSync(root, { recursive: true });
  ensureChatChartOutputDir(conversationId);
  // The generic Agent delivery protocol writes only user-facing files here.
  fs.mkdirSync(path.join(root, 'deliverables'), { recursive: true });
  ensureJunction(path.join(root, 'knowledge-corpus'), getCorpusRoot());
  return root;
}

function isChartFile(fileName: string) {
  return GENERATED_CHART_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function mediaTypeFor(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function walkFiles(directory: string, depth = 0): string[] {
  if (depth > 4 || !fs.existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      files.push(...walkFiles(full, depth + 1));
    } else {
      files.push(full);
    }
  }
  return files;
}

function conversationRoots(conversationId: string) {
  const names = new Set(conversationChartAliases(conversationId));
  const root = chatWorkspacesRoot();
  if (!fs.existsSync(root)) {
    return [...names].map((name) => path.join(root, name));
  }
  const compact = conversationId.replace(/-/g, '');
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.replace(/-/g, '') === compact || names.has(entry.name)) {
      names.add(entry.name);
    }
  }
  return [...names].map((name) => path.join(root, name));
}

export function resolvePythonCommand() {
  const candidates = [['python'], ['py', '-3'], ['python3']];
  for (const command of candidates) {
    const probe = spawnSync(command[0], [...command.slice(1), '--version'], {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true
    });
    if (probe.status === 0) return command;
  }
  throw new Error('未找到可用的 Python（python / py -3 / python3）。');
}

function chartRenderScript() {
  return path.join(process.cwd(), 'tools', 'chart-discovery', 'scripts', 'render_chart.py');
}

function renderSpec(specPath: string, outPath: string) {
  const python = resolvePythonCommand();
  const result = spawnSync(python[0], [...python.slice(1), chartRenderScript(), '--spec', specPath, '--out', outPath], {
    encoding: 'utf8',
    cwd: process.cwd(),
    timeout: 30_000,
    windowsHide: true
  });
  if (result.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error((result.stderr || result.stdout || '出图脚本失败').trim());
  }
  return outPath;
}

function ensureChartPngMargins(filePaths: string[]) {
  const pngs = [...new Set(
    filePaths.filter((filePath) => path.extname(filePath).toLowerCase() === '.png' && fs.existsSync(filePath))
  )];
  if (!pngs.length) return;
  const python = resolvePythonCommand();
  const result = spawnSync(
    python[0],
    [...python.slice(1), chartRenderScript(), '--ensure-margin', ...pngs],
    {
      encoding: 'utf8',
      cwd: process.cwd(),
      timeout: 30_000,
      windowsHide: true
    }
  );
  if (result.status !== 0) {
    console.error('[chat] ensure chart margin failed', (result.stderr || result.stdout || '').trim());
  }
}

function readManifestTargets(manifestPath: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [];
    return rows
      .map((row) => {
        if (!row || typeof row !== 'object') return '';
        const record = row as { file?: unknown; name?: unknown };
        return String(record.file || record.name || '').trim();
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function collectWorkspaceFiles(roots: string[], options: { startedAtMs?: number } = {}) {
  const charts: Array<{ name: string; filePath: string }> = [];
  const specs: string[] = [];
  const manifests: string[] = [];
  const seenCharts = new Set<string>();
  for (const root of roots) {
    for (const filePath of walkFiles(root)) {
      const name = path.basename(filePath);
      if (isChartFile(name)) {
        const key = path.resolve(filePath).toLowerCase();
        const stat = fs.statSync(filePath);
        if (seenCharts.has(key) || !stat.size) continue;
        if (options.startedAtMs != null && stat.mtimeMs + 1000 < options.startedAtMs) continue;
        seenCharts.add(key);
        charts.push({ name, filePath });
        continue;
      }
      if (name.toLowerCase() === 'manifest.json') {
        manifests.push(filePath);
        continue;
      }
      if (SPEC_NAME_RE.test(name) || name.toLowerCase().endsWith('.json')) {
        if (options.startedAtMs != null) {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs + 1000 < options.startedAtMs) continue;
        }
        try {
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { kind?: unknown; series?: unknown };
          if (parsed && typeof parsed === 'object' && parsed.kind && Array.isArray(parsed.series)) {
            specs.push(filePath);
          }
        } catch {
          // 不是出图规格
        }
      }
    }
    for (const manifestPath of manifests) {
      const dir = path.dirname(manifestPath);
      for (const relative of readManifestTargets(manifestPath)) {
        const target = path.resolve(dir, relative);
        if (!isChartFile(target) || !fs.existsSync(target)) continue;
        let realTarget: string;
        let realRoot: string;
        try {
          realTarget = fs.realpathSync(target);
          realRoot = fs.realpathSync(root);
        } catch {
          continue;
        }
        if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) continue;
        const stat = fs.statSync(realTarget);
        if (!stat.size || (options.startedAtMs != null && stat.mtimeMs + 1000 < options.startedAtMs)) continue;
        const key = realTarget.toLowerCase();
        if (seenCharts.has(key)) continue;
        seenCharts.add(key);
        charts.push({ name: path.basename(realTarget), filePath: realTarget });
      }
    }
  }
  return { charts, specs };
}

function copyIntoCanonical(canonicalDir: string, filePath: string, preferredName: string) {
  fs.mkdirSync(canonicalDir, { recursive: true });
  const target = path.join(canonicalDir, preferredName);
  if (path.resolve(filePath) !== path.resolve(target)) {
    fs.copyFileSync(filePath, target);
  }
  return target;
}

export async function harvestGeneratedChartAttachments(
  conversationId: string,
  messageId: string,
  options: { startedAtMs?: number } = {}
): Promise<ChatAttachment[]> {
  const canonicalDir = ensureChatChartOutputDir(conversationId);
  const roots = conversationRoots(conversationId);
  const collected = collectWorkspaceFiles(roots, options);
  const files = new Map<string, string>();

  for (const chart of collected.charts) {
    if (!files.has(chart.name.toLowerCase())) files.set(chart.name.toLowerCase(), chart.filePath);
  }

  for (const specPath of collected.specs) {
    const stem = path.basename(specPath, path.extname(specPath)).replace(/^spec[-_]/i, '');
    const outName = `${stem || 'chart'}.png`;
    if (files.has(outName.toLowerCase())) continue;
    const outPath = path.join(canonicalDir, outName);
    try {
      renderSpec(specPath, outPath);
      files.set(outName.toLowerCase(), outPath);
    } catch (error) {
      console.error('[chat] render chart spec failed', specPath, error);
    }
    if (files.size >= MAX_CHARTS_PER_TURN) break;
  }

  const selected = [...files.entries()].slice(0, MAX_CHARTS_PER_TURN);
  if (!selected.length) return [];

  const prepared: Array<{ fileName: string; storedPath: string }> = [];
  for (const [name, filePath] of selected) {
    try {
      const fileName = path.basename(filePath) || name;
      prepared.push({ fileName, storedPath: copyIntoCanonical(canonicalDir, filePath, fileName) });
    } catch (error) {
      console.error('[chat] copy generated chart failed', filePath, error);
    }
  }
  if (!prepared.length) return [];
  ensureChartPngMargins(prepared.map((item) => item.storedPath));

  const attachments: ChatAttachment[] = [];
  for (const { fileName, storedPath } of prepared) {
    try {
      const stored = await storeChatAttachment(
        conversationId,
        { name: fileName, type: mediaTypeFor(fileName), buffer: fs.readFileSync(storedPath) },
        {
          allowedExtensions: GENERATED_CHART_EXTENSIONS,
          extraMetadata: {
            role: 'generated-chart',
            sourcePath: path.posix.join(chatChartOutputRelative(conversationId), fileName)
          }
        }
      );
      if (stored.deduplicated && stored.attachment.messageId && stored.attachment.messageId !== messageId) {
        continue;
      }
      attachments.push(stored.attachment);
    } catch (error) {
      console.error('[chat] store generated chart failed', storedPath, error);
    }
  }
  if (!attachments.length) return [];
  return bindChatAttachmentsToMessage(
    conversationId,
    messageId,
    attachments.map((attachment) => attachment.id)
  );
}
