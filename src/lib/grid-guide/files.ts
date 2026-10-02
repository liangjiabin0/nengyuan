import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import type { GridGuideFileNode } from './types';
import { gridGuideTaskDirectory, gridGuideWorkspaceRoot } from './workspace';

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.log',
  '.ndjson'
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const MAX_TEXT_BYTES = 1_500_000;

function assertProjectId(projectId: string) {
  const id = String(projectId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('无效的项目指南 ID。');
  return id;
}

export function normalizeRelativePath(value: string) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!raw) throw new Error('文件路径不能为空。');
  if (raw.includes('\0') || raw.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('无效的文件路径。');
  }
  return raw;
}

export function toWorkspaceRelative(projectId: string, absolutePath: string) {
  const id = assertProjectId(projectId);
  const root = path.resolve(gridGuideWorkspaceRoot(id));
  const absolute = path.resolve(absolutePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error('文件路径超出工作区。');
  }
  return absolute.slice(root.length + 1).replace(/\\/g, '/');
}

export function resolveGridGuideFilePath(projectId: string, relativePath: string) {
  const id = assertProjectId(projectId);
  const root = path.resolve(gridGuideWorkspaceRoot(id));
  const relative = normalizeRelativePath(relativePath);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error('文件路径超出工作区。');
  }
  return { id, root, relative, absolute };
}

export function gridGuideFileExtension(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

export function isTextGridGuideFile(fileName: string) {
  return TEXT_EXTENSIONS.has(gridGuideFileExtension(fileName));
}

export function isImageGridGuideFile(fileName: string) {
  return IMAGE_EXTENSIONS.has(gridGuideFileExtension(fileName));
}

function compareNames(a: string, b: string) {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function readDirTree(root: string, relativeDir: string, depth = 0): GridGuideFileNode[] {
  if (depth > 12) return [];
  const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: GridGuideFileNode[] = [];
  for (const entry of entries) {
    if (entry.name === '.opencode' || entry.name === 'knowledge-corpus') continue;
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relative,
        type: 'dir',
        children: readDirTree(root, relative, depth + 1)
      });
      continue;
    }
    if (!entry.isFile()) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(absoluteDir, entry.name)).size;
    } catch {
      size = 0;
    }
    nodes.push({
      name: entry.name,
      path: relative,
      type: 'file',
      extension: gridGuideFileExtension(entry.name),
      size
    });
  }
  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return compareNames(a.name, b.name);
  });
}

export function listGridGuideFileTree(projectId: string): GridGuideFileNode[] {
  const id = assertProjectId(projectId);
  const root = gridGuideWorkspaceRoot(id);
  if (!fs.existsSync(root)) return [];
  return readDirTree(root, '');
}

export function readGridGuideTextFile(projectId: string, relativePath: string) {
  const { absolute, relative } = resolveGridGuideFilePath(projectId, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error('文件不存在。');
  }
  if (!isTextGridGuideFile(relative)) {
    throw new Error('该文件不是可编辑文本。');
  }
  const size = fs.statSync(absolute).size;
  if (size > MAX_TEXT_BYTES) throw new Error('文件过大，请下载后查看。');
  return fs.readFileSync(absolute, 'utf8');
}

export function writeGridGuideTextFile(projectId: string, relativePath: string, content: string) {
  const { absolute, relative, root } = resolveGridGuideFilePath(projectId, relativePath);
  if (!isTextGridGuideFile(relative)) {
    throw new Error('该文件不支持在线编辑。');
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error('文件不存在。');
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(absolute);
  if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('文件路径超出工作区。');
  }
  const next = content.replace(/\r\n/g, '\n');
  if (!next.trim()) throw new Error('内容不能为空。');
  fs.writeFileSync(absolute, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  return { path: relative, size: Buffer.byteLength(next, 'utf8') };
}

export async function zipGridGuideWorkspace(projectId: string, taskFolder?: string) {
  const id = assertProjectId(projectId);
  const taskDir = gridGuideTaskDirectory(id, taskFolder);
  const root = taskDir && fs.existsSync(taskDir) ? taskDir : gridGuideWorkspaceRoot(id);
  if (!fs.existsSync(root)) throw new Error('工作区尚不存在。');
  const tempFile = path.join(os.tmpdir(), `grid-guide-${id}-${Date.now()}.zip`);
  const output = fs.createWriteStream(tempFile);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.pipe(output);
  archive.glob('**/*', {
    cwd: root,
    ignore: ['.opencode/**', '**/.opencode/**', 'knowledge-corpus/**', '**/knowledge-corpus/**'],
    dot: false
  });
  const finalize = archive.finalize();
  await Promise.all([finalize, finished(output)]);
  try {
    return fs.readFileSync(tempFile);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // ignore
    }
  }
}

export function readGridGuideBinaryFile(projectId: string, relativePath: string) {
  const { absolute, relative } = resolveGridGuideFilePath(projectId, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error('文件不存在。');
  }
  return {
    absolute,
    relative,
    buffer: fs.readFileSync(absolute),
    extension: gridGuideFileExtension(relative)
  };
}
