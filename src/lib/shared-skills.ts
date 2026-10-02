import fs from 'node:fs';
import path from 'node:path';
import unzipper from 'unzipper';
import { parse as parseYaml } from 'yaml';
import { annotateMarkitdownSkillContent } from './attachments/markitdown-cli';
import {
  bundledSkillMarkdownPath,
  COMPOSER_GATED_BUNDLED_SKILLS,
  MARKITDOWN_SKILL,
  ensureBundledSkills
} from './bundled-skills';
import { OFFICE_DOCS_SKILLS, annotateOfficeDocsSkillContent } from './office-docs-cli';
import { all, get, run } from './db';
import {
  canDeleteSharedSkill,
  canEditSharedSkill,
  isSharedSkillOwner
} from './skill-permissions';
import { isSystemSkillRemoved, markSystemSkillCustomized, markSystemSkillRemoved } from './skill-removed';
import { canLoadSkillWhenRequested, isCatalogSkill } from './skill-visibility';

export { canDeleteSharedSkill, canEditSharedSkill, isSharedSkillOwner };

export const SHARED_SKILLS_ROOT = path.join(process.cwd(), 'storage', '.opencode', 'skills');
export const SHARED_SKILL_PREFIX = 'shared-';
export const SHARED_SKILL_MAX_BYTES = 20 * 1024 * 1024;
export const SHARED_SKILL_MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
export const SHARED_SKILL_MAX_FILES = 256;
export const SHARED_SKILL_MAX_PROMPT_CHARS = 24_000;
export const SHARED_SKILL_MAX_PROMPT_TOTAL = 80_000;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SharedSkillRow = {
  id: string;
  name: string;
  title: string;
  description: string;
  uploaded_by: string | null;
  uploaded_by_name: string;
  created_at: string;
  updated_at: string;
};

export type SharedSkill = {
  id: string;
  name: string;
  title: string;
  description: string;
  uploadedBy: string | null;
  uploadedByName: string;
  createdAt: string;
  updatedAt: string;
  source?: 'shared' | 'system';
  canDelete?: boolean;
  canEdit?: boolean;
};

export function withSkillPermissions<T extends Pick<SharedSkill, 'source' | 'uploadedBy'>>(
  skills: T[],
  user?: { id?: string | null; role?: string | null } | null
) {
  return skills.map((skill) => ({
    ...skill,
    canDelete: canDeleteSharedSkill(skill, user),
    canEdit: canEditSharedSkill(skill, user)
  }));
}

export type LoadedSharedSkill = SharedSkill & {
  content: string;
};

function toClient(row: SharedSkillRow): SharedSkill {
  return {
    id: row.id,
    name: row.name,
    title: row.title || row.name,
    description: row.description || '',
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSkillKey(value: string) {
  return NAME_RE.test(value);
}

export function normalizeSkillIds(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? (() => {
          try {
            return JSON.parse(value) as unknown[];
          } catch {
            return [];
          }
        })()
      : [];
  return [...new Set(
    raw
      .map((item) => String(item || '').trim())
      .filter((item) => UUID_RE.test(item) || isSkillKey(item))
  )];
}

export function skillDirectory(name: string) {
  return path.join(SHARED_SKILLS_ROOT, name);
}

export function skillMarkdownPath(name: string) {
  return path.join(skillDirectory(name), 'SKILL.md');
}

function shouldSkipZipEntry(entryPath: string) {
  const normalized = entryPath.replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/')) return true;
  const parts = normalized.split('/');
  return parts.some((part) => part === '__MACOSX' || part === '.' || part === '..' || part.startsWith('.'));
}

function parseFrontmatter(text: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const body = match ? match[2] : text;
  const raw = match ? match[1] : '';
  let fields: Record<string, unknown> = {};
  try {
    const parsed = raw ? parseYaml(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      fields = parsed as Record<string, unknown>;
    }
  } catch {
    fields = {};
  }
  const heading = body.match(/^#\s+(.+)$/m);
  return {
    name: String(fields.name || '').trim(),
    title: String(fields.title || heading?.[1] || '').trim(),
    description: String(fields.description || '').trim(),
    body: body.trim()
  };
}

export function parseSkillMarkdown(text: string) {
  return parseFrontmatter(text);
}

function yamlScalar(value: string) {
  return JSON.stringify(String(value || ''));
}

const SKILL_TITLE_MAX = 80;
const SKILL_DESCRIPTION_MAX = 1024;

export function normalizeCustomSkillInput(input: {
  name?: string;
  title?: string;
  description?: string;
  body?: string;
}) {
  const title = String(input.title || '').trim();
  const description = String(input.description || '').trim();
  const body = String(input.body || '').trim();
  const requestedName = String(input.name || '').trim();
  if (!title) throw new Error('请填写技能名称。');
  if (!description) throw new Error('请填写技能描述。');
  if (!body) throw new Error('请填写技能正文。');
  if (title.length > SKILL_TITLE_MAX) throw new Error(`技能名称不能超过 ${SKILL_TITLE_MAX} 个字。`);
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new Error(`技能描述不能超过 ${SKILL_DESCRIPTION_MAX} 个字。`);
  }
  if (body.length > SHARED_SKILL_MAX_PROMPT_CHARS) {
    throw new Error(`技能正文不能超过 ${SHARED_SKILL_MAX_PROMPT_CHARS} 个字。`);
  }
  return { title, description, body, requestedName };
}

export async function allocateSkillName(preferred: string) {
  const compact = String(preferred || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const base = compact && NAME_RE.test(compact)
    ? sanitizeSkillName(compact)
    : sanitizeSkillName(`custom-${Date.now().toString(36)}`);
  if (!(await getSharedSkillByName(base))) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 64);
    if (!(await getSharedSkillByName(candidate))) return candidate;
  }
  return sanitizeSkillName(`custom-${crypto.randomUUID().slice(0, 8)}`);
}

export function sanitizeSkillName(value: string, fallback = 'skill') {
  const compact = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const base = compact && NAME_RE.test(compact) ? compact : fallback;
  const prefixed = base.startsWith(SHARED_SKILL_PREFIX) ? base : `${SHARED_SKILL_PREFIX}${base}`;
  return prefixed.slice(0, 64);
}

function readSkillMarkdown(name: string) {
  const file = resolveSkillMarkdownPath(name);
  if (!file) return '';
  return fs.readFileSync(file, 'utf8');
}

function resolveSkillMarkdownPath(name: string) {
  if (COMPOSER_GATED_BUNDLED_SKILLS.has(name)) {
    return bundledSkillMarkdownPath(name);
  }
  const roots = name.startsWith(SHARED_SKILL_PREFIX)
    ? [SHARED_SKILLS_ROOT]
    : [SHARED_SKILLS_ROOT];
  const root = roots.find((candidate) => candidate && fs.existsSync(path.join(candidate, name, 'SKILL.md')));
  if (root) {
    const file = path.join(root, name, 'SKILL.md');
    if (fs.existsSync(file)) return file;
  }
  return bundledSkillMarkdownPath(name);
}

function resolveSkillDirectory(name: string) {
  const markdown = resolveSkillMarkdownPath(name);
  return markdown ? path.dirname(markdown) : skillDirectory(name);
}

function clipPromptContent(text: string, limit = SHARED_SKILL_MAX_PROMPT_CHARS) {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n\n…（技能正文已截断，完整说明请用 skill 工具继续加载）`;
}

export async function listSharedSkills() {
  const rows = await all<SharedSkillRow>(
    `SELECT id, name, title, description, uploaded_by, uploaded_by_name, created_at, updated_at
     FROM shared_skills
     ORDER BY updated_at DESC, created_at DESC`
  );
  return rows.map(toClient);
}

function listSkillDirectories(kind: 'shared' | 'all' = 'shared') {
  if (!fs.existsSync(SHARED_SKILLS_ROOT)) return [];
  return fs.readdirSync(SHARED_SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) return false;
      if (!NAME_RE.test(entry.name)) return false;
      if (kind === 'shared') return entry.name.startsWith(SHARED_SKILL_PREFIX);
      return fs.existsSync(skillMarkdownPath(entry.name));
    })
    .map((entry) => entry.name);
}

function listSharedSkillDirectories() {
  return listSkillDirectories('shared');
}

function listCatalogSkillDirectories() {
  return listSkillDirectories('all');
}

const SKILL_FILE_MAX_BYTES = 1024 * 1024;
const SKILL_FILE_BATCH_MAX = 64;
const SKIP_SKILL_DIRS = new Set(['__pycache__', '.venv', 'node_modules']);
const BINARY_SKILL_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.gz', '.tgz', '.7z', '.rar', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.pyc', '.so', '.dll', '.exe', '.bin', '.parquet'
]);

export type SkillFileEntry = {
  path: string;
  size: number;
  binary: boolean;
};

export type SkillFileContent = {
  path: string;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
};

export function normalizeSkillRelativePath(input: string) {
  const slashed = String(input || '').replace(/\\/g, '/').trim();
  if (!slashed || slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed) || slashed.length > 240) {
    throw new Error('文件路径无效。');
  }
  const relative = slashed;
  const parts = relative.split('/');
  if (parts.length > 12) throw new Error('文件路径过深。');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.startsWith('.')) {
      throw new Error('文件路径无效。');
    }
    if (part !== part.trim() || /[<>:"|?*\u0000-\u001f]/.test(part)) {
      throw new Error('文件路径无效。');
    }
  }
  return parts.join('/');
}

export function isBinarySkillPath(relativePath: string) {
  return BINARY_SKILL_EXT.has(path.posix.extname(relativePath).toLowerCase());
}

function resolveInsideSkill(root: string, relativePath: string) {
  const relative = normalizeSkillRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('文件路径无效。');
  }
  return { relative, target };
}

function shouldSkipSkillDir(name: string) {
  return name.startsWith('.') || SKIP_SKILL_DIRS.has(name);
}

export function listSharedSkillFileEntries(name: string): SkillFileEntry[] {
  const root = resolveSkillDirectory(name);
  if (!fs.existsSync(root)) return [];
  const files: SkillFileEntry[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipSkillDir(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const relative = path.relative(root, full).replace(/\\/g, '/');
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        files.push({
          path: relative,
          size,
          binary: isBinarySkillPath(relative)
        });
      }
    }
  };
  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function listSharedSkillFiles(name: string) {
  return listSharedSkillFileEntries(name).map((file) => file.path);
}

export function readSharedSkillFile(name: string, relativePath: string): SkillFileContent {
  const root = resolveSkillDirectory(name);
  if (!fs.existsSync(root)) throw new Error('技能不存在。');
  const { relative, target } = resolveInsideSkill(root, relativePath);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error('文件不存在。');
  const size = fs.statSync(target).size;
  if (isBinarySkillPath(relative)) {
    return { path: relative, content: null, binary: true, tooLarge: false, size };
  }
  if (size > SKILL_FILE_MAX_BYTES) {
    return { path: relative, content: null, binary: false, tooLarge: true, size };
  }
  const buffer = fs.readFileSync(target);
  if (buffer.includes(0)) {
    return { path: relative, content: null, binary: true, tooLarge: false, size };
  }
  return {
    path: relative,
    content: buffer.toString('utf8'),
    binary: false,
    tooLarge: false,
    size
  };
}

function copySkillTree(source: string, target: string) {
  fs.cpSync(source, target, {
    recursive: true,
    filter: (from) => !shouldSkipSkillDir(path.basename(from))
  });
}

function materializeSkillDirectory(name: string) {
  const dest = assertSafeSkillDirectory(name);
  if (fs.existsSync(path.join(dest, 'SKILL.md'))) return dest;
  const source = resolveSkillDirectory(name);
  if (
    path.resolve(source) !== path.resolve(dest)
    && fs.existsSync(path.join(source, 'SKILL.md'))
  ) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copySkillTree(source, dest);
    return dest;
  }
  fs.mkdirSync(dest, { recursive: true });
  return dest;
}

function pruneEmptySkillDirs(root: string, fromFile: string) {
  let dir = path.dirname(fromFile);
  const resolvedRoot = path.resolve(root);
  while (path.resolve(dir) !== resolvedRoot && path.resolve(dir).startsWith(`${resolvedRoot}${path.sep}`)) {
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

export async function saveCatalogSkillFiles(
  name: string,
  input: {
    source?: 'shared' | 'system';
    files?: Array<{ path?: string; content?: string }>;
    deleted?: string[];
  }
) {
  if (!NAME_RE.test(name)) throw new Error('技能标识无效。');
  const files = Array.isArray(input.files) ? input.files : [];
  const deleted = Array.isArray(input.deleted) ? input.deleted : [];
  if (files.length + deleted.length > SKILL_FILE_BATCH_MAX) {
    throw new Error(`一次最多保存 ${SKILL_FILE_BATCH_MAX} 个文件。`);
  }
  const root = materializeSkillDirectory(name);
  for (const raw of deleted) {
    const { relative, target } = resolveInsideSkill(root, String(raw || ''));
    if (relative.toLowerCase() === 'skill.md') throw new Error('不能删除 SKILL.md。');
    if (!fs.existsSync(target)) continue;
    if (!fs.statSync(target).isFile()) throw new Error('只能删除文件。');
    fs.rmSync(target);
    pruneEmptySkillDirs(root, target);
  }
  for (const file of files) {
    const { relative, target } = resolveInsideSkill(root, String(file?.path || ''));
    if (relative.toLowerCase() === 'skill.md') throw new Error('SKILL.md 请通过技能正文保存。');
    if (isBinarySkillPath(relative)) throw new Error(`不能在编辑器里保存二进制文件：${relative}`);
    const content = typeof file?.content === 'string' ? file.content : '';
    if (Buffer.byteLength(content, 'utf8') > SKILL_FILE_MAX_BYTES) {
      throw new Error(`${relative} 超过 1 MB，不能保存。`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  const markdown = path.join(root, 'SKILL.md');
  if (fs.existsSync(markdown)) {
    const now = new Date();
    fs.utimesSync(markdown, now, now);
  }
  if (input.source === 'system') markSystemSkillCustomized(name);
  else {
    await run(
      `UPDATE shared_skills SET updated_at = CURRENT_TIMESTAMP WHERE name = ?`,
      [name],
      true
    );
  }
  return listSharedSkillFileEntries(name);
}

export function readSharedSkillMarkdown(name: string) {
  return readSkillMarkdown(name);
}

/** 把磁盘上的 shared-* 技能同步进目录表，供技能库页面和对话工具共用。 */
export async function syncSharedSkillsFromDisk() {
  const existing = await all<SharedSkillRow>(
    `SELECT id, name, title, description, uploaded_by, uploaded_by_name, created_at, updated_at
     FROM shared_skills`
  );
  const byName = new Map(existing.map((row) => [row.name, row]));
  const diskNames = new Set(listSharedSkillDirectories());
  for (const name of diskNames) {
    const raw = readSkillMarkdown(name);
    if (!raw.trim()) continue;
    const parsed = parseFrontmatter(raw);
    const title = parsed.title || parsed.name || name;
    const description = parsed.description || '';
    const found = byName.get(name);
    if (!found) {
      await run(
        `INSERT INTO shared_skills (id, name, title, description, uploaded_by, uploaded_by_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [crypto.randomUUID(), name, title, description, null, '智能对话'],
        true
      );
      continue;
    }
    if (found.title !== title || found.description !== description) {
      await run(
        `UPDATE shared_skills SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [title, description, found.id],
        true
      );
    }
  }
  for (const row of existing) {
    if (diskNames.has(row.name)) continue;
    await run('DELETE FROM shared_skills WHERE id = ?', [row.id], true);
  }
  return listSharedSkills();
}

export function buildSkillMarkdown(input: {
  name: string;
  title?: string;
  description?: string;
  body?: string;
  shared?: boolean;
}) {
  const name = input.shared === false
    ? String(input.name || '').trim()
    : sanitizeSkillName(input.name);
  if (!NAME_RE.test(name)) throw new Error('技能标识只能包含小写字母、数字和连字符。');
  const title = String(input.title || '').trim() || name;
  const description = String(input.description || '').trim();
  const body = String(input.body || '').trim() || `# ${title}\n`;
  return [
    '---',
    `name: ${name}`,
    `title: ${yamlScalar(title)}`,
    `description: ${yamlScalar(description)}`,
    '---',
    '',
    body.startsWith('#') ? body : `# ${title}\n\n${body}`,
    ''
  ].join('\n');
}

export async function writeSharedSkillMarkdown(input: {
  name: string;
  markdown: string;
  uploadedBy?: string;
  uploadedByName?: string;
}) {
  const parsed = parseFrontmatter(input.markdown);
  const name = sanitizeSkillName(parsed.name || input.name);
  if (!NAME_RE.test(name)) throw new Error('技能名称只能包含小写字母、数字和连字符。');
  const title = parsed.title || parsed.name || name;
  const description = parsed.description || '';
  const markdown = input.markdown.includes('---')
    ? input.markdown
    : buildSkillMarkdown({ name, title, description, body: input.markdown });
  const root = skillDirectory(name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(skillMarkdownPath(name), markdown, 'utf8');
  const existing = await getSharedSkillByName(name);
  if (existing) {
    await run(
      `UPDATE shared_skills SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [title, description, existing.id],
      true
    );
    const updated = await getSharedSkill(existing.id);
    if (!updated) throw new Error('技能更新失败。');
    return { skill: updated, created: false };
  }
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO shared_skills (id, name, title, description, uploaded_by, uploaded_by_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, name, title, description, input.uploadedBy || null, input.uploadedByName || '智能对话'],
    true
  );
  const created = await getSharedSkill(id);
  if (!created) throw new Error('技能保存失败。');
  return { skill: created, created: true };
}

export async function getSharedSkill(id: string) {
  const row = await get<SharedSkillRow>(
    `SELECT id, name, title, description, uploaded_by, uploaded_by_name, created_at, updated_at
     FROM shared_skills WHERE id = ?`,
    [id]
  );
  return row ? toClient(row) : null;
}

export async function getSharedSkillByName(name: string) {
  const row = await get<SharedSkillRow>(
    `SELECT id, name, title, description, uploaded_by, uploaded_by_name, created_at, updated_at
     FROM shared_skills WHERE name = ?`,
    [name]
  );
  return row ? toClient(row) : null;
}

function readSystemSkill(name: string): SharedSkill | null {
  if (!NAME_RE.test(name) || name.startsWith(SHARED_SKILL_PREFIX)) return null;
  const raw = readSkillMarkdown(name);
  if (!raw.trim()) return null;
  const parsed = parseFrontmatter(raw);
  let updatedAt = '';
  try {
    updatedAt = fs.statSync(skillMarkdownPath(name)).mtime.toISOString();
  } catch {
    updatedAt = '';
  }
  return {
    id: name,
    name,
    title: parsed.title || parsed.name || name,
    description: parsed.description || '',
    uploadedBy: null,
    uploadedByName: '系统',
    createdAt: updatedAt,
    updatedAt,
    source: 'system'
  };
}

export async function getCatalogSkill(idOrName: string): Promise<SharedSkill | null> {
  const key = String(idOrName || '').trim();
  if (!key) return null;
  const shared = await getSharedSkill(key) || await getSharedSkillByName(key);
  if (shared) return { ...shared, source: 'shared' };
  return readSystemSkill(key);
}

function renameSkillDirectory(fromName: string, toName: string) {
  if (fromName === toName) return;
  const source = skillDirectory(fromName);
  const target = skillDirectory(toName);
  if (fs.existsSync(target)) throw new Error(`技能标识 ${toName} 已存在。`);
  if (fs.existsSync(source)) fs.renameSync(source, target);
}

export async function createCustomSharedSkill(input: {
  name?: string;
  title?: string;
  description?: string;
  body?: string;
  uploadedBy?: string;
  uploadedByName?: string;
}): Promise<SharedSkill> {
  const { title, description, body, requestedName } = normalizeCustomSkillInput(input);
  const name = requestedName
    ? sanitizeSkillName(requestedName)
    : await allocateSkillName(title);
  if (!NAME_RE.test(name)) throw new Error('技能标识只能包含小写字母、数字和连字符。');
  const existing = await getSharedSkillByName(name);
  if (existing) throw new Error(`技能 ${name} 已存在，请更换标识。`);
  const markdown = buildSkillMarkdown({ name, title, description, body });
  fs.mkdirSync(skillDirectory(name), { recursive: true });
  fs.writeFileSync(skillMarkdownPath(name), markdown, 'utf8');
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO shared_skills (id, name, title, description, uploaded_by, uploaded_by_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, name, title, description, input.uploadedBy || null, input.uploadedByName || ''],
    true
  );
  const created = await getSharedSkill(id);
  if (!created) throw new Error('技能保存失败。');
  return created;
}

export async function updateSharedSkill(id: string, input: {
  name?: string;
  title?: string;
  description?: string;
  body?: string;
}): Promise<{ skill: SharedSkill; renamedFrom?: string }> {
  const current = await getSharedSkill(id);
  if (!current) throw new Error('技能不存在。');
  const parsed = parseFrontmatter(readSkillMarkdown(current.name));
  const { title, description, body, requestedName } = normalizeCustomSkillInput({
    title: input.title ?? current.title,
    description: input.description ?? current.description,
    body: input.body ?? parsed.body,
    name: input.name ?? current.name
  });
  let nextName = current.name;
  if (requestedName) {
    const sanitized = sanitizeSkillName(requestedName);
    if (!NAME_RE.test(sanitized)) throw new Error('技能标识只能包含小写字母、数字和连字符。');
    if (sanitized !== current.name) {
      const clash = await getSharedSkillByName(sanitized);
      if (clash && clash.id !== current.id) throw new Error(`技能 ${sanitized} 已存在，请更换标识。`);
      renameSkillDirectory(current.name, sanitized);
      nextName = sanitized;
    }
  }
  fs.mkdirSync(skillDirectory(nextName), { recursive: true });
  fs.writeFileSync(
    skillMarkdownPath(nextName),
    buildSkillMarkdown({ name: nextName, title, description, body }),
    'utf8'
  );
  await run(
    `UPDATE shared_skills
     SET name = ?, title = ?, description = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextName, title, description, current.id],
    true
  );
  const updated = await getSharedSkill(current.id);
  if (!updated) throw new Error('技能更新失败。');
  return {
    skill: updated,
    renamedFrom: nextName !== current.name ? current.name : undefined
  };
}

function assertSafeSkillDirectory(name: string) {
  if (!NAME_RE.test(name)) throw new Error('技能标识只能包含小写字母、数字和连字符。');
  const root = path.resolve(SHARED_SKILLS_ROOT);
  const dir = path.resolve(skillDirectory(name));
  if (dir === root || !dir.startsWith(`${root}${path.sep}`)) {
    throw new Error('技能目录无效。');
  }
  return dir;
}

async function updateSystemSkill(
  current: SharedSkill,
  input: {
    name?: string;
    title?: string;
    description?: string;
    body?: string;
  }
): Promise<{ skill: SharedSkill; renamedFrom?: string }> {
  const requestedName = String(input.name || '').trim();
  if (requestedName && requestedName !== current.name) {
    throw new Error('系统技能标识不能修改。');
  }
  const parsed = parseFrontmatter(readSkillMarkdown(current.name));
  const { title, description, body } = normalizeCustomSkillInput({
    title: input.title ?? current.title,
    description: input.description ?? current.description,
    body: input.body ?? parsed.body,
    name: current.name
  });
  const dir = materializeSkillDirectory(current.name);
  if (!fs.existsSync(skillMarkdownPath(current.name))) throw new Error('技能不存在。');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    skillMarkdownPath(current.name),
    buildSkillMarkdown({ name: current.name, title, description, body, shared: false }),
    'utf8'
  );
  markSystemSkillCustomized(current.name);
  const updated = readSystemSkill(current.name);
  if (!updated) throw new Error('技能更新失败。');
  return { skill: updated };
}

export async function updateCatalogSkill(idOrName: string, input: {
  name?: string;
  title?: string;
  description?: string;
  body?: string;
}): Promise<{ skill: SharedSkill; renamedFrom?: string }> {
  const current = await getCatalogSkill(idOrName);
  if (!current) throw new Error('技能不存在。');
  if (current.source === 'shared') {
    return updateSharedSkill(current.id, input);
  }
  return updateSystemSkill(current, input);
}

export async function listCatalogSkills(): Promise<SharedSkill[]> {
  ensureBundledSkills();
  const shared = await syncSharedSkillsFromDisk();
  const sharedNames = new Set(shared.map((skill) => skill.name));
  const catalog: SharedSkill[] = shared.map((skill) => ({ ...skill, source: 'shared' as const }));
  for (const name of listCatalogSkillDirectories()) {
    if (sharedNames.has(name) || isSystemSkillRemoved(name)) continue;
    const raw = readSkillMarkdown(name);
    if (!raw.trim()) continue;
    const parsed = parseFrontmatter(raw);
    let updatedAt = '';
    try {
      const markdownPath = resolveSkillMarkdownPath(name);
      updatedAt = markdownPath ? fs.statSync(markdownPath).mtime.toISOString() : '';
    } catch {
      updatedAt = '';
    }
    catalog.push({
      id: name,
      name,
      title: parsed.title || parsed.name || name,
      description: parsed.description || '',
      uploadedBy: null,
      uploadedByName: '系统',
      createdAt: updatedAt,
      updatedAt,
      source: 'system'
    });
  }
  catalog.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'shared' ? -1 : 1;
    return String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
  });
  return catalog.filter(isCatalogSkill);
}

export async function loadSharedSkillsForPrompt(ids: string[]): Promise<LoadedSharedSkill[]> {
  const skillIds = normalizeSkillIds(ids);
  if (!skillIds.length) return [];
  const uuids = skillIds.filter((item) => UUID_RE.test(item));
  const rows = uuids.length
    ? await all<SharedSkillRow>(
      `SELECT id, name, title, description, uploaded_by, uploaded_by_name, created_at, updated_at
       FROM shared_skills
       WHERE id IN (${uuids.map(() => '?').join(', ')})`,
      uuids
    )
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const loaded: LoadedSharedSkill[] = [];
  let used = 0;
  for (const key of skillIds) {
    const remaining = SHARED_SKILL_MAX_PROMPT_TOTAL - used;
    if (remaining < 400) break;
    const row = UUID_RE.test(key) ? byId.get(key) : undefined;
    const name = row?.name || (!UUID_RE.test(key) ? key : '');
    if (!name || !canLoadSkillWhenRequested(name)) continue;
    const raw = readSkillMarkdown(name);
    if (!raw.trim()) continue;
    const parsed = parseFrontmatter(raw);
    const content = clipPromptContent(parsed.body || raw, Math.min(SHARED_SKILL_MAX_PROMPT_CHARS, remaining));
    const annotated = name === MARKITDOWN_SKILL
      ? annotateMarkitdownSkillContent(content)
      : OFFICE_DOCS_SKILLS.has(name)
        ? annotateOfficeDocsSkillContent(content, name)
        : content;
    used += annotated.length;
    loaded.push({
      id: row?.id || name,
      name,
      title: parsed.title || row?.title || name,
      description: parsed.description || row?.description || '',
      uploadedBy: row?.uploaded_by || null,
      uploadedByName: row?.uploaded_by_name || (row ? '' : '系统'),
      createdAt: row?.created_at || '',
      updatedAt: row?.updated_at || '',
      source: row || name.startsWith(SHARED_SKILL_PREFIX) ? 'shared' : 'system',
      content: annotated
    });
  }
  return loaded;
}

function writeSkillTree(name: string, files: Array<{ relativePath: string; buffer: Buffer }>) {
  const root = skillDirectory(name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const file of files) {
    const relative = file.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relative || relative.includes('..')) continue;
    const target = path.join(root, relative);
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(target);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.buffer);
  }
}

async function extractSkillUpload(fileName: string, buffer: Buffer) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.md' || extension === '.markdown') {
    return [{ relativePath: 'SKILL.md', buffer }];
  }
  if (extension !== '.zip') {
    throw new Error('请上传 SKILL.md 或包含 SKILL.md 的 ZIP 技能包。');
  }
  const directory = await unzipper.Open.buffer(buffer);
  const entries: Array<{ relativePath: string; buffer: Buffer }> = [];
  let extractedBytes = 0;
  for (const file of directory.files) {
    if (file.type === 'Directory') continue;
    const relativePath = String(file.path || '').replace(/\\/g, '/');
    if (shouldSkipZipEntry(relativePath)) continue;
    const content = await file.buffer();
    if (!content.length) continue;
    extractedBytes += content.length;
    if (extractedBytes > SHARED_SKILL_MAX_EXTRACTED_BYTES) {
      throw new Error(`技能包解压后不能超过 ${Math.round(SHARED_SKILL_MAX_EXTRACTED_BYTES / 1024 / 1024)} MB。`);
    }
    if (entries.length >= SHARED_SKILL_MAX_FILES) {
      throw new Error(`技能包文件数不能超过 ${SHARED_SKILL_MAX_FILES} 个。`);
    }
    entries.push({ relativePath, buffer: content });
  }
  const skillFiles = entries.filter((entry) => path.posix.basename(entry.relativePath).toLowerCase() === 'skill.md');
  if (!skillFiles.length) {
    throw new Error('压缩包中未找到 SKILL.md。');
  }
  skillFiles.sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
  const skillRoot = path.posix.dirname(skillFiles[0]!.relativePath);
  const prefix = skillRoot === '.' ? '' : `${skillRoot}/`;
  return entries
    .filter((entry) => (prefix ? entry.relativePath.startsWith(prefix) : true))
    .map((entry) => ({
      relativePath: prefix ? entry.relativePath.slice(prefix.length) : entry.relativePath,
      buffer: entry.buffer
    }))
    .filter((entry) => entry.relativePath);
}

export async function createSharedSkill(input: {
  fileName: string;
  buffer: Buffer;
  uploadedBy?: string;
  uploadedByName?: string;
}): Promise<SharedSkill> {
  if (!input.buffer.length) throw new Error('上传文件为空。');
  if (input.buffer.length > SHARED_SKILL_MAX_BYTES) {
    throw new Error(`技能包不能超过 ${Math.round(SHARED_SKILL_MAX_BYTES / 1024 / 1024)} MB。`);
  }
  const files = await extractSkillUpload(input.fileName, input.buffer);
  const skillMd = files.find((file) => path.posix.basename(file.relativePath).toLowerCase() === 'skill.md');
  if (!skillMd) throw new Error('未找到 SKILL.md。');
  const parsed = parseFrontmatter(skillMd.buffer.toString('utf8'));
  const stem = path.basename(input.fileName, path.extname(input.fileName));
  const name = sanitizeSkillName(parsed.name || stem);
  if (!NAME_RE.test(name)) throw new Error('技能名称只能包含小写字母、数字和连字符。');
  const existing = await getSharedSkillByName(name);
  if (existing) throw new Error(`技能 ${name} 已存在，请先删除或更换名称。`);
  const title = parsed.title || parsed.name || stem || name;
  const description = parsed.description || '';
  writeSkillTree(name, files.map((file) => (
    path.posix.basename(file.relativePath).toLowerCase() === 'skill.md'
      ? { ...file, relativePath: 'SKILL.md' }
      : file
  )));
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO shared_skills (id, name, title, description, uploaded_by, uploaded_by_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, name, title, description, input.uploadedBy || null, input.uploadedByName || ''],
    true
  );
  const created = await getSharedSkill(id);
  if (!created) throw new Error('技能保存失败。');
  return created;
}

export async function deleteSharedSkill(id: string) {
  const skill = await getSharedSkill(id);
  if (!skill) return false;
  fs.rmSync(skillDirectory(skill.name), { recursive: true, force: true });
  await run('DELETE FROM shared_skills WHERE id = ?', [id], true);
  return true;
}

export async function deleteCatalogSkill(idOrName: string) {
  const key = String(idOrName || '').trim();
  if (!key) return false;
  const shared = await getSharedSkill(key) || await getSharedSkillByName(key);
  if (shared) return deleteSharedSkill(shared.id);

  const system = readSystemSkill(key);
  if (!system || !NAME_RE.test(system.name)) return false;
  const root = path.resolve(SHARED_SKILLS_ROOT);
  const dir = path.resolve(skillDirectory(system.name));
  if (dir === root || !dir.startsWith(`${root}${path.sep}`)) return false;
  if (!fs.existsSync(skillMarkdownPath(system.name))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  markSystemSkillRemoved(system.name);
  return true;
}

export function buildSharedSkillPrompt(skills: LoadedSharedSkill[]) {
  if (!skills.length) return '';
  const names = skills.map((skill) => `\`${skill.name}\``).join('、');
  const bodies = skills.map((skill) => {
    const refs = path.posix.join('storage/.opencode/skills', skill.name);
    return [
      `### 技能 ${skill.title || skill.name}`,
      skill.description ? `说明：${skill.description}` : '',
      `OpenCode skill 名：${skill.name}`,
      `附件目录：${refs}`,
      skill.content
    ].filter(Boolean).join('\n');
  });
  return [
    `本次对话已自动加载 ${skills.length} 个共享技能（${names}）。请严格按这些技能的说明执行。`,
    '如技能要求先用 skill 工具加载，请立即加载同名技能，以便继续读取其 refs / scripts。',
    bodies.join('\n\n')
  ].join('\n\n');
}
