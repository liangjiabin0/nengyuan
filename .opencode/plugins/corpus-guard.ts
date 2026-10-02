import fs from 'node:fs';
import path from 'node:path';

type ToolBeforeInput = {
  tool: string;
};

type ToolBeforeOutput = {
  args: Record<string, unknown>;
};

type ToolAfterInput = {
  tool: string;
  args: Record<string, unknown>;
};

type ToolAfterOutput = {
  title: string;
  output: string;
  metadata: unknown;
};

const DOMAIN_RE = 'people|papers|patents|whitepapers|projects|national-projects|outputs|attachments';
const ISOLATED_SCOPE_RE = 'patents|research-review|grid-guides|scheme-solve|paper-repro|chat-workspaces';
const ISOLATED_WORKDIR_RE = new RegExp(
  `\\/storage\\/(?:${ISOLATED_SCOPE_RE})\\/[^/]+(?:\\/[^/]+)?$`,
  'i'
);
const BLOCKED_MENTOR_RE = /(?:^|\/)mentors(?:\/|$)/i;
const ATTACHMENT_MD_RE = /^knowledge-corpus\/attachments\/[a-f0-9]{24}\/[a-f0-9]{24}\.md$/i;
const BARE_ATTACHMENT_MD_RE = /^[a-f0-9]{24}\.md$/i;

function assertNotMentorCorpus(rawPath: unknown) {
  const text = rawPath == null ? '' : String(rawPath).replace(/\\/g, '/');
  if (BLOCKED_MENTOR_RE.test(text)) {
    throw new Error(
      '本地 knowledge-corpus/mentors 已停用。请使用 web_search / webfetch 通过互联网检索。'
    );
  }
}

function isUnder(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 模型常误写绝对路径（漏掉 storage），例如 D:/电元系统/patents/{id}/...
 * 从任意写法中提取 patents/{uuid}/... 相对片段。
 */
function coercePatentRelativePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const normalized = rawPath.replace(/\\/g, '/');
  if (/(?:^|\/)knowledge-corpus(?:\/|$)/i.test(normalized)) return null;
  const match = normalized.match(/(patents\/[0-9a-f-]{36}(?:\/[\w./+\u4e00-\u9fff-]*)?)/i);
  if (!match) {
    if (/^patents\/?$/i.test(normalized) || normalized.endsWith('/patents') || normalized.endsWith('/patents/')) {
      return 'patents';
    }
    return null;
  }
  return match[1].replace(/\/+$/, '');
}

/** Patent drafting workspace under storage/patents/{id}/... — bypass corpus-only guards. */
function resolvePatentWorkspaceTarget(directory: string, rawPath: unknown) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const projectId = path.basename(directory);
  const directoryIsIsolatedPatent = /^[0-9a-f-]{36}$/i.test(projectId)
    && path.basename(path.dirname(directory)).toLowerCase() === 'patents';
  if (directoryIsIsolatedPatent) {
    const normalized = String(rawPath).replace(/\\/g, '/');
    const embeddedPrefix = new RegExp(`^.*?patents/${projectId}/`, 'i');
    const localPath = normalized.replace(embeddedPrefix, '');
    const resolved = path.resolve(directory, localPath);
    const allowedRoot = path.resolve(directory, 'opencode');
    if (!isUnder(allowedRoot, resolved)) return null;
    return {
      resolved,
      relative: path.relative(directory, resolved).replace(/\\/g, '/')
    };
  }
  const coerced = coercePatentRelativePath(rawPath) || String(rawPath).replace(/\\/g, '/');
  const patentsRoot = path.resolve(directory, 'patents');
  const resolved = path.resolve(directory, coerced);
  if (!isUnder(patentsRoot, resolved)) return null;
  const inside = path.relative(directory, resolved).replace(/\\/g, '/');
  return {
    resolved,
    relative: inside.startsWith('patents/') ? inside : `patents/${inside}`
  };
}

function isPatentWorkspacePath(directory: string, rawPath: unknown) {
  return Boolean(resolvePatentWorkspaceTarget(directory, rawPath));
}

function isIsolatedResearchReviewDirectory(directory: string) {
  const projectId = path.basename(directory);
  return /^[0-9a-f-]{36}$/i.test(projectId)
    && path.basename(path.dirname(directory)).toLowerCase() === 'research-review';
}

/** Research-review session cwd: storage/research-review/{id}/ with literature/ refs/ INDEX.md */
function resolveResearchReviewWorkspaceTarget(directory: string, rawPath: unknown) {
  if (!isIsolatedResearchReviewDirectory(directory)) return null;
  if (rawPath === undefined || rawPath === null || !String(rawPath).trim()) {
    return {
      resolved: directory,
      relative: '.'
    };
  }
  const normalized = String(rawPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    normalized === '.'
    || normalized === './'
    || normalized === 'storage'
    || /\/storage\/?$/i.test(normalized)
  ) {
    return {
      resolved: directory,
      relative: '.'
    };
  }
  // Bare literature filename → literature/<name>
  const bare = path.posix.basename(normalized);
  const candidates = [
    path.resolve(directory, normalized),
    path.resolve(directory, 'literature', bare),
    path.resolve(directory, 'refs', bare)
  ];
  for (const resolved of candidates) {
    if (!isUnder(directory, resolved)) continue;
    if (resolved !== directory && !fs.existsSync(resolved) && !normalized.includes('/')) {
      continue;
    }
    if (!isUnder(directory, resolved)) continue;
    return {
      resolved,
      relative: path.relative(directory, resolved).replace(/\\/g, '/') || '.'
    };
  }
  const fallback = path.resolve(directory, normalized);
  if (!isUnder(directory, fallback)) return null;
  return {
    resolved: fallback,
    relative: path.relative(directory, fallback).replace(/\\/g, '/') || '.'
  };
}

function isResearchReviewWorkspacePath(directory: string, rawPath: unknown) {
  return Boolean(resolveResearchReviewWorkspaceTarget(directory, rawPath));
}

const GRID_GUIDE_RESERVED_ROOT = new Set([
  'literature',
  'refs',
  '.opencode',
  'INDEX.md',
  'TASK.md',
  'knowledge-corpus'
]);

function isIsolatedGridGuideDirectory(directory: string) {
  const projectId = path.basename(directory);
  return (
    /^[0-9a-f-]{36}$/i.test(projectId)
    && path.basename(path.dirname(directory)).toLowerCase() === 'grid-guides'
  );
}

function isIsolatedNonPatentDirectory(directory: string) {
  const projectId = path.basename(directory);
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return false;
  const scope = path.basename(path.dirname(directory)).toLowerCase();
  return scope === 'grid-guides' || scope === 'research-review' || scope === 'scheme-solve' || scope === 'paper-repro' || scope === 'chat-workspaces';
}

/**
 * 隔离工作区里模型常写错语料路径。统一成 knowledge-corpus/<分域>，
 * 避免把 patents/patents、../../knowledge-corpus/papers 误判成工作区内部目录后死循环。
 */
function coerceIsolatedCorpusPath(rawPath: unknown, directory?: string): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const corpusMatch = normalized.match(
    new RegExp(`(?:^|.*/)(knowledge-corpus(?:/(?:${DOMAIN_RE})(?:/.*)?)?)/?$`, 'i')
  );
  if (corpusMatch?.[1]) return corpusMatch[1].replace(/\/+$/, '');
  if (directory && isIsolatedNonPatentDirectory(directory) && /^patents(?:\/patents)?(?:\/.*)?$/i.test(normalized)) {
    const rest = normalized.replace(/^patents(?:\/patents)?\/?/i, '');
    return rest ? `knowledge-corpus/patents/${rest}` : 'knowledge-corpus/patents';
  }
  return null;
}

function applyIsolatedCorpusAlias(directory: string, output: ToolBeforeOutput) {
  const raw = output.args.path ?? output.args.filePath ?? output.args.file;
  const coerced = coerceIsolatedCorpusPath(raw, directory);
  if (!coerced) return false;
  rewriteCorpusToolPath(directory, output, coerced);
  return true;
}

function isKnowledgeCorpusPathText(pathText: string) {
  const normalized = pathText.replace(/\\/g, '/');
  return /(?:^|\/)knowledge-corpus(?:\/|$)/i.test(normalized);
}

function coerceGridGuideRelativePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const normalized = rawPath.replace(/\\/g, '/');
  const match = normalized.match(/(grid-guides\/[0-9a-f-]{36}(?:\/[\w./+\u4e00-\u9fff-]*)?)/i);
  if (!match) {
    if (/^grid-guides\/?$/i.test(normalized) || normalized.endsWith('/grid-guides') || normalized.endsWith('/grid-guides/')) {
      return 'grid-guides';
    }
    return null;
  }
  return match[1].replace(/\/+$/, '');
}

/** Grid-guide session cwd: storage/grid-guides/{id}/ with literature/ refs/ INDEX.md TASK.md */
function resolveGridGuideWorkspaceTarget(directory: string, rawPath: unknown) {
  if (isIsolatedGridGuideDirectory(directory)) {
    if (rawPath === undefined || rawPath === null || !String(rawPath).trim()) {
      return {
        resolved: directory,
        relative: '.'
      };
    }
    const normalized = String(rawPath).replace(/\\/g, '/').replace(/^\.\//, '');
    if (isKnowledgeCorpusPathText(normalized)) return null;
    if (coerceIsolatedCorpusPath(normalized, directory)) return null;
    if (/^patents(\/|$)/i.test(normalized) && !fs.existsSync(path.join(directory, 'patents'))) return null;
    if (
      normalized === '.'
      || normalized === './'
      || normalized === 'storage'
      || /\/storage\/?$/i.test(normalized)
    ) {
      return {
        resolved: directory,
        relative: '.'
      };
    }
    const projectId = path.basename(directory);
    const embeddedPrefix = new RegExp(`^.*?grid-guides/${projectId}/`, 'i');
    const localPath = normalized.replace(embeddedPrefix, '');
    const resolved = path.resolve(directory, localPath);
    if (!isUnder(directory, resolved)) return null;
    return {
      resolved,
      relative: path.relative(directory, resolved).replace(/\\/g, '/') || '.'
    };
  }
  const coerced = coerceGridGuideRelativePath(rawPath);
  if (!coerced) return null;
  const guidesRoot = path.resolve(directory, 'grid-guides');
  const resolved = path.resolve(directory, coerced);
  if (!isUnder(guidesRoot, resolved)) return null;
  const inside = path.relative(directory, resolved).replace(/\\/g, '/');
  return {
    resolved,
    relative: inside.startsWith('grid-guides/') ? inside : `grid-guides/${inside}`
  };
}

function isGridGuideWorkspacePath(directory: string, rawPath: unknown) {
  return Boolean(resolveGridGuideWorkspaceTarget(directory, rawPath));
}

function coerceSchemeSolveRelativePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const normalized = rawPath.replace(/\\/g, '/');
  const match = normalized.match(/(scheme-solve(?:\/[\w./+\u4e00-\u9fff-]+)*)/i);
  if (!match) return null;
  return match[1].replace(/\/+$/, '') || 'scheme-solve';
}

function isIsolatedSchemeSolveDirectory(directory: string) {
  return /\/storage\/scheme-solve\/[0-9a-f-]{36}(?:\/[0-9a-f-]{36})?$/i.test(directory.replace(/\\/g, '/'));
}

/** Scheme-solve workspace: storage/scheme-solve/{session}/[idea]/INDEX.md IDEA.md DESIGN.md model.json */
function resolveSchemeSolveWorkspaceTarget(directory: string, rawPath: unknown) {
  if (isIsolatedSchemeSolveDirectory(directory)) {
    if (rawPath === undefined || rawPath === null || !String(rawPath).trim()) {
      return { resolved: directory, relative: '.' };
    }
    const normalized = String(rawPath).replace(/\\/g, '/').replace(/^\.\//, '');
    if (isKnowledgeCorpusPathText(normalized)) return null;
    if (normalized === '.' || normalized === './' || normalized === 'storage' || /\/storage\/?$/i.test(normalized)) {
      return { resolved: directory, relative: '.' };
    }
    const coerced = coerceSchemeSolveRelativePath(normalized);
    const localPath = coerced
      ? normalized.replace(/^.*?scheme-solve\/[0-9a-f-]{36}(?:\/[0-9a-f-]{36})?(?:\/|$)/i, '') || '.'
      : normalized;
    const resolved = path.resolve(directory, localPath);
    if (!isUnder(directory, resolved)) return null;
    return {
      resolved,
      relative: path.relative(directory, resolved).replace(/\\/g, '/') || '.'
    };
  }
  const coerced = coerceSchemeSolveRelativePath(rawPath);
  if (!coerced) return null;
  const storageDir = storageRootFromDirectory(directory);
  const resolved = path.resolve(storageDir, coerced);
  const schemeRoot = path.resolve(storageDir, 'scheme-solve');
  if (resolved !== schemeRoot && !isUnder(schemeRoot, resolved)) return null;
  const fromCwd = path.relative(directory, resolved).replace(/\\/g, '/');
  return {
    resolved,
    relative: fromCwd.startsWith('..') ? coerced : fromCwd
  };
}

function isSchemeSolveWorkspacePath(directory: string, rawPath: unknown) {
  return Boolean(resolveSchemeSolveWorkspaceTarget(directory, rawPath));
}

function isIsolatedPaperReproDirectory(directory: string) {
  const projectId = path.basename(directory);
  return (
    /^[0-9a-f-]{36}$/i.test(projectId)
    && path.basename(path.dirname(directory)).toLowerCase() === 'paper-repro'
  );
}

function coercePaperReproRelativePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const normalized = rawPath.replace(/\\/g, '/');
  const match = normalized.match(/(paper-repro\/[0-9a-f-]{36}(?:\/[\w./+\u4e00-\u9fff-]*)?)/i);
  if (!match) {
    if (/^paper-repro\/?$/i.test(normalized) || normalized.endsWith('/paper-repro') || normalized.endsWith('/paper-repro/')) {
      return 'paper-repro';
    }
    return null;
  }
  return match[1].replace(/\/+$/, '');
}

/** Paper-repro session cwd: storage/paper-repro/{id}/ with INDEX.md literature/ files/ src/ */
function resolvePaperReproWorkspaceTarget(directory: string, rawPath: unknown) {
  if (isIsolatedPaperReproDirectory(directory)) {
    if (rawPath === undefined || rawPath === null || !String(rawPath).trim()) {
      return { resolved: directory, relative: '.' };
    }
    const normalized = String(rawPath).replace(/\\/g, '/').replace(/^\.\//, '');
    if (isKnowledgeCorpusPathText(normalized)) return null;
    if (
      normalized === '.'
      || normalized === './'
      || normalized === 'storage'
      || /\/storage\/?$/i.test(normalized)
    ) {
      return { resolved: directory, relative: '.' };
    }
    const projectId = path.basename(directory);
    const embeddedPrefix = new RegExp(`^.*?paper-repro/${projectId}/`, 'i');
    const localPath = normalized.replace(embeddedPrefix, '');
    const resolved = path.resolve(directory, localPath);
    if (!isUnder(directory, resolved)) return null;
    return {
      resolved,
      relative: path.relative(directory, resolved).replace(/\\/g, '/') || '.'
    };
  }
  const coerced = coercePaperReproRelativePath(rawPath);
  if (!coerced) return null;
  const storageDir = storageRootFromDirectory(directory);
  const resolved = path.resolve(storageDir, coerced);
  const paperRoot = path.resolve(storageDir, 'paper-repro');
  if (resolved !== paperRoot && !isUnder(paperRoot, resolved)) return null;
  const fromCwd = path.relative(directory, resolved).replace(/\\/g, '/');
  return {
    resolved,
    relative: fromCwd.startsWith('..') ? coerced : fromCwd
  };
}

function isPaperReproWorkspacePath(directory: string, rawPath: unknown) {
  return Boolean(resolvePaperReproWorkspaceTarget(directory, rawPath));
}

function isIsolatedChatWorkspaceDirectory(directory: string) {
  const projectId = path.basename(directory);
  return (
    /^[0-9a-f-]{36}$/i.test(projectId)
    && path.basename(path.dirname(directory)).toLowerCase() === 'chat-workspaces'
  );
}

function coerceChatWorkspaceRelativePath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const normalized = rawPath.replace(/\\/g, '/');
  const match = normalized.match(/(chat-workspaces\/[0-9a-f-]{36}(?:\/[\w./+\u4e00-\u9fff-]*)?)/i);
  if (!match) {
    if (/^chat-workspaces\/?$/i.test(normalized) || normalized.endsWith('/chat-workspaces') || normalized.endsWith('/chat-workspaces/')) {
      return 'chat-workspaces';
    }
    return null;
  }
  return match[1].replace(/\/+$/, '');
}

/** 智能对话 cwd：storage 根（旧）或 storage/chat-workspaces/{id}（现）。 */
function isChatDirectory(directory: string) {
  return isChatStorageRoot(directory) || isIsolatedChatWorkspaceDirectory(directory);
}

/** Chat session cwd: storage/chat-workspaces/{id}/ with charts/ and a knowledge-corpus junction. */
function resolveChatWorkspaceTarget(directory: string, rawPath: unknown) {
  if (isIsolatedChatWorkspaceDirectory(directory)) {
    if (rawPath === undefined || rawPath === null || !String(rawPath).trim()) {
      return { resolved: directory, relative: '.' };
    }
    const normalized = String(rawPath).replace(/\\/g, '/').replace(/^\.\//, '');
    if (isKnowledgeCorpusPathText(normalized)) return null;
    if (coerceIsolatedCorpusPath(normalized, directory)) return null;
    if (
      normalized === '.'
      || normalized === './'
      || normalized === 'storage'
      || /\/storage\/?$/i.test(normalized)
    ) {
      return { resolved: directory, relative: '.' };
    }
    const projectId = path.basename(directory);
    const embeddedPrefix = new RegExp(`^(?:.*\\/)?(?:storage\\/)?chat-workspaces/${projectId}/`, 'i');
    const localPath = normalized.replace(embeddedPrefix, '');
    const resolved = path.resolve(directory, localPath);
    if (!isUnder(directory, resolved)) return null;
    if (resolved !== directory && !normalized.includes('/') && !fs.existsSync(resolved)) {
      return null;
    }
    return {
      resolved,
      relative: path.relative(directory, resolved).replace(/\\/g, '/') || '.'
    };
  }
  const coerced = coerceChatWorkspaceRelativePath(rawPath);
  if (!coerced) return null;
  const storageDir = storageRootFromDirectory(directory);
  const resolved = path.resolve(storageDir, coerced);
  const chatRoot = path.resolve(storageDir, 'chat-workspaces');
  if (resolved !== chatRoot && !isUnder(chatRoot, resolved)) return null;
  const fromCwd = path.relative(directory, resolved).replace(/\\/g, '/');
  return {
    resolved,
    relative: fromCwd.startsWith('..') ? coerced : fromCwd
  };
}

function isChatWorkspacePath(directory: string, rawPath: unknown) {
  return Boolean(resolveChatWorkspaceTarget(directory, rawPath));
}

/** 智能问答 cwd 是 storage 根；允许跑本机程序、读写语料库以外的绝对路径。 */
function isChatStorageRoot(directory: string) {
  return path.basename(path.resolve(directory)).toLowerCase() === 'storage';
}

function isAllowedChatExternalPath(rawPath: unknown) {
  if (rawPath == null || !String(rawPath).trim()) return false;
  const text = String(rawPath);
  const normalized = text.replace(/\\/g, '/');
  if (BLOCKED_MENTOR_RE.test(normalized)) return false;
  if (isKnowledgeCorpusPathText(normalized)) return false;
  if (/^chat-workspaces(\/|$)/i.test(normalized.replace(/^\.\//, ''))) return true;
  return path.isAbsolute(text) || /^[a-zA-Z]:[\\/]/.test(text);
}

function assertGridGuideWritable(relative: string) {
  const stripped = relative
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^grid-guides\/[0-9a-f-]{36}\//i, '');
  if (!stripped || stripped === '.') {
    throw new Error('禁止写入国网指南工作目录根；成果只能写在本次任务子文件夹内');
  }
  const first = stripped.split('/').filter(Boolean)[0] || '';
  if (GRID_GUIDE_RESERVED_ROOT.has(first)) {
    throw new Error('禁止写入 literature/、refs/、知识库或工作目录根文件；成果只能写在本次任务子文件夹内');
  }
  if (!stripped.includes('/')) {
    throw new Error('成果文件必须写在任务子文件夹内，不能写在工作目录根');
  }
}

function projectRootFromDirectory(directory: string) {
  const normalized = directory.replace(/\\/g, '/');
  // Isolated cwd: .../storage/{patents|research-review|grid-guides|scheme-solve|paper-repro}/{uuid}
  const isolated = normalized.match(
    new RegExp(`^(.*)/storage/(?:${ISOLATED_SCOPE_RE})/[^/]+(?:/[^/]+)?$`, 'i')
  );
  if (isolated) {
    return (isolated[1] || path.parse(directory).root).replace(/\//g, path.sep);
  }
  const base = path.basename(directory).toLowerCase();
  if (base === 'storage') return path.dirname(directory);
  if (path.basename(path.dirname(directory)).toLowerCase() === 'storage') {
    return path.dirname(path.dirname(directory));
  }
  return directory;
}

function resolveSkillsRoot(directory: string) {
  return path.resolve(projectRootFromDirectory(directory), '.opencode', 'skills');
}

function resolveSharedSkillWriteTarget(directory: string, rawPath: unknown) {
  const normalized = String(rawPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const explicit = normalized.match(/(?:^|\/)\.opencode\/skills\/(shared-[a-z0-9-]+)(\/[\w./+\u4e00-\u9fff-]*)?$/i);
  if (explicit) {
    return {
      relative: `.opencode/skills/${explicit[1]}${explicit[2] || '/SKILL.md'}`
    };
  }
  const skill = resolveSkillTarget(directory, rawPath);
  if (!skill) return null;
  const inside = skill.knowledgeRelative.replace(/^\.opencode\/skills\/?/, '');
  const folder = inside.split('/')[0] || '';
  if (!folder.startsWith('shared-')) {
    throw new Error('只能修改 shared-* 共享技能，不能改写内置 skill');
  }
  return { relative: skill.knowledgeRelative };
}

/** Allow read/list/glob under project .opencode/skills for research-review / patent skills. */
function resolveSkillTarget(directory: string, rawPath: unknown) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const skillsRoot = resolveSkillsRoot(directory);
  const normalized = String(rawPath).replace(/\\/g, '/').replace(/^\.\//, '');
  // 禁止把语料/专利/指南路径拼进 skills 目录（否则 knowledge-corpus/** 会被误判为 skill）
  if (/^(knowledge-corpus|patents|grid-guides|scheme-solve)(\/|$)/i.test(normalized)) return null;
  const stripped = normalized.replace(/^\.opencode\/skills\//i, '');
  const explicitSkillPath = /^\.opencode\/skills(\/|$)/i.test(normalized);
  const candidates = [
    path.resolve(directory, normalized),
    path.resolve(directory, '.opencode', 'skills', stripped),
    path.resolve(skillsRoot, stripped),
    path.resolve(skillsRoot, normalized),
    path.resolve(skillsRoot, 'writing-source-grounded-research-reviews', normalized),
    path.resolve(skillsRoot, 'writing-source-grounded-research-reviews', stripped),
    path.resolve(skillsRoot, 'sgcc-tech-guide', normalized),
    path.resolve(skillsRoot, 'sgcc-tech-guide', stripped),
    path.resolve(projectRootFromDirectory(directory), normalized)
  ];
  for (const resolved of candidates) {
    if (!isUnder(skillsRoot, resolved)) continue;
    // 非显式 .opencode/skills 路径时，必须真实存在，避免任意相对路径被拼进 skills
    if (!explicitSkillPath && !fs.existsSync(resolved)) continue;
    const inside = path.relative(skillsRoot, resolved).replace(/\\/g, '/');
    // Prefer storage/.opencode/skills junction (created by sidecar) so OpenCode cwd can resolve it.
    return {
      resolved,
      knowledgeRelative: inside === '' ? '.opencode/skills' : `.opencode/skills/${inside}`,
      isManifest: false,
      isCorpusRoot: false,
      isPatentWorkspace: false as const,
      isSkillWorkspace: true as const,
      isAttachmentRecord: false,
      isResearchReviewWorkspace: false as const,
      isGridGuideWorkspace: false as const,
      isSchemeSolveWorkspace: false as const,
      isPaperReproWorkspace: false as const,
      isChatWorkspace: false as const
    };
  }
  return null;
}

function storageRootFromDirectory(directory: string) {
  const normalized = directory.replace(/\\/g, '/');
  const isolated = normalized.match(
    new RegExp(`^(.*)/storage/(?:${ISOLATED_SCOPE_RE})/[^/]+(?:/[^/]+)?$`, 'i')
  );
  if (isolated) {
    return path.join((isolated[1] || path.parse(directory).root).replace(/\//g, path.sep), 'storage');
  }
  if (path.basename(directory).toLowerCase() === 'storage') return directory;
  const nested = path.join(directory, 'storage');
  if (fs.existsSync(nested)) return nested;
  return directory;
}

function knowledgeCorpusRoot(directory: string) {
  return path.resolve(storageRootFromDirectory(directory), 'knowledge-corpus');
}

function resolveBareAttachmentPath(directory: string, fileName: string) {
  const attachmentsRoot = path.resolve(knowledgeCorpusRoot(directory), 'attachments');
  if (!fs.existsSync(attachmentsRoot)) return null;
  try {
    const dirs = fs.readdirSync(attachmentsRoot, { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(attachmentsRoot, entry.name, fileName);
      if (fs.existsSync(candidate)) {
        return path.posix.join('knowledge-corpus', 'attachments', entry.name, fileName);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveCorpusTarget(directory: string, rawPath: unknown) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('知识问答工具必须显式指定 knowledge-corpus 路径');
  }
  let pathText = String(rawPath).replace(/\\/g, '/');
  const aliased = coerceIsolatedCorpusPath(pathText, directory);
  if (aliased) pathText = aliased;
  if (
    pathText === '.'
    || pathText === './'
    || pathText === 'storage'
    || /\/storage\/?$/i.test(pathText)
    || /^[a-z]:\/.*\/storage\/?$/i.test(pathText)
  ) {
    throw new Error(
      '禁止把工作目录根或 "." 当作工具 path。专利文件请用 opencode/SOURCE.md；语料请用 knowledge-corpus/...'
    );
  }
  const research = resolveResearchReviewWorkspaceTarget(directory, pathText);
  if (research) {
    return {
      resolved: research.resolved,
      knowledgeRelative: research.relative,
      isManifest: research.relative === 'INDEX.md',
      isCorpusRoot: false,
      isPatentWorkspace: false as const,
      isSkillWorkspace: false as const,
      isAttachmentRecord: research.relative.startsWith('literature/'),
      isResearchReviewWorkspace: true as const,
      isGridGuideWorkspace: false as const
    };
  }

  const gridGuide = resolveGridGuideWorkspaceTarget(directory, pathText);
  if (gridGuide) {
    return {
      resolved: gridGuide.resolved,
      knowledgeRelative: gridGuide.relative,
      isManifest: gridGuide.relative === 'INDEX.md' || gridGuide.relative === 'TASK.md',
      isCorpusRoot: false,
      isPatentWorkspace: false as const,
      isSkillWorkspace: false as const,
      isAttachmentRecord: gridGuide.relative.startsWith('literature/'),
      isResearchReviewWorkspace: false as const,
      isGridGuideWorkspace: true as const
    };
  }

  const schemeSolve = resolveSchemeSolveWorkspaceTarget(directory, pathText);
  if (schemeSolve) {
    return {
      resolved: schemeSolve.resolved,
      knowledgeRelative: schemeSolve.relative,
      isManifest: /(?:^|\/)(?:INDEX|IDEA|DESIGN|REPORT)\.md$/i.test(schemeSolve.relative),
      isCorpusRoot: false,
      isPatentWorkspace: false as const,
      isSkillWorkspace: false as const,
      isAttachmentRecord: /(?:^|\/)literature\//i.test(schemeSolve.relative),
      isResearchReviewWorkspace: false as const,
      isGridGuideWorkspace: false as const,
      isSchemeSolveWorkspace: true as const
    };
  }

  const paperRepro = resolvePaperReproWorkspaceTarget(directory, pathText);
  if (paperRepro) {
    return {
      resolved: paperRepro.resolved,
      knowledgeRelative: paperRepro.relative,
      isManifest: paperRepro.relative === 'INDEX.md',
      isCorpusRoot: false,
      isPatentWorkspace: false as const,
      isSkillWorkspace: false as const,
      isAttachmentRecord: /(?:^|\/)(?:literature|files)\//i.test(paperRepro.relative),
      isResearchReviewWorkspace: false as const,
      isGridGuideWorkspace: false as const,
      isSchemeSolveWorkspace: false as const,
      isPaperReproWorkspace: true as const,
      isChatWorkspace: false as const
    };
  }

  const chatWorkspace = resolveChatWorkspaceTarget(directory, pathText);
  if (chatWorkspace) {
    return {
      resolved: chatWorkspace.resolved,
      knowledgeRelative: chatWorkspace.relative,
      isManifest: false,
      isCorpusRoot: false,
      isPatentWorkspace: false as const,
      isSkillWorkspace: false as const,
      isAttachmentRecord: /(?:^|\/)attachments\//i.test(chatWorkspace.relative),
      isResearchReviewWorkspace: false as const,
      isGridGuideWorkspace: false as const,
      isSchemeSolveWorkspace: false as const,
      isPaperReproWorkspace: false as const,
      isChatWorkspace: true as const
    };
  }

  if (BARE_ATTACHMENT_MD_RE.test(path.posix.basename(pathText))) {
    const recovered = resolveBareAttachmentPath(directory, path.posix.basename(pathText));
    if (recovered) pathText = recovered;
  }

  // 附件优先于 skill，避免被 skills 路径拼接误判
  if (ATTACHMENT_MD_RE.test(pathText.replace(/\\/g, '/'))) {
    const corpusRoot = knowledgeCorpusRoot(directory);
    const stripped = pathText.replace(/^knowledge-corpus\/?/i, '');
    const resolved = path.resolve(corpusRoot, stripped);
    if (isUnder(corpusRoot, resolved)) {
      const inside = path.relative(corpusRoot, resolved).replace(/\\/g, '/');
      return {
        resolved,
        knowledgeRelative: `knowledge-corpus/${inside}`,
        isManifest: false,
        isCorpusRoot: false,
        isPatentWorkspace: false as const,
        isSkillWorkspace: false as const,
        isAttachmentRecord: true,
        isResearchReviewWorkspace: false as const,
        isGridGuideWorkspace: false as const
      };
    }
  }

  const skill = resolveSkillTarget(directory, pathText);
  if (skill) return skill;

  const patent = resolvePatentWorkspaceTarget(directory, pathText);
  if (patent) {
    return {
      resolved: patent.resolved,
      knowledgeRelative: patent.relative,
      isManifest: false,
      isCorpusRoot: false,
      isPatentWorkspace: true as const,
      isSkillWorkspace: false as const,
      isAttachmentRecord: false,
      isResearchReviewWorkspace: false as const,
      isGridGuideWorkspace: false as const
    };
  }
  const corpusRoot = knowledgeCorpusRoot(directory);
  const corpusRelative = pathText.replace(/^knowledge-corpus\/?/i, '');
  const resolved = corpusRelative
    ? path.resolve(corpusRoot, corpusRelative)
    : corpusRoot;
  if (!isUnder(corpusRoot, resolved) || !isKnowledgeCorpusPathText(pathText)) {
    throw new Error(`拒绝访问 Markdown 语料目录之外的路径：${rawPath}`);
  }
  const inside = path.relative(corpusRoot, resolved).replace(/\\/g, '/');
  const knowledgeRelative = inside === '' ? 'knowledge-corpus' : `knowledge-corpus/${inside}`;
  return {
    resolved,
    knowledgeRelative,
    isManifest: knowledgeRelative === 'knowledge-corpus/MANIFEST.md',
    isCorpusRoot: knowledgeRelative === 'knowledge-corpus',
    isPatentWorkspace: false as const,
    isSkillWorkspace: false as const,
    isAttachmentRecord: ATTACHMENT_MD_RE.test(knowledgeRelative),
    isResearchReviewWorkspace: false as const,
    isGridGuideWorkspace: false as const
  };
}

function validateCorpusPath(directory: string, rawPath: unknown) {
  resolveCorpusTarget(directory, rawPath);
}

function rewriteToolPath(output: ToolBeforeOutput, knowledgeRelative: string) {
  if (typeof output.args.filePath === 'string') {
    output.args.filePath = knowledgeRelative;
  }
  if (typeof output.args.path === 'string') {
    output.args.path = knowledgeRelative;
  }
}

function hasLocalCorpusJunction(directory: string) {
  const local = path.join(directory, 'knowledge-corpus');
  try {
    if (!fs.existsSync(local)) return false;
    if (fs.existsSync(path.join(local, 'MANIFEST.md'))) return true;
    return fs.lstatSync(local).isSymbolicLink()
      || fs.realpathSync(local) !== path.resolve(local);
  } catch {
    return false;
  }
}

/** Isolated cwd is storage/{scope}/{uuid}; corpus lives at storage/knowledge-corpus. */
function rewriteCorpusToolPath(directory: string, output: ToolBeforeOutput, knowledgeRelative: string) {
  const normalized = directory.replace(/\\/g, '/');
  const isolated = ISOLATED_WORKDIR_RE.test(normalized);
  const useLocalJunction = isolated && hasLocalCorpusJunction(directory);
  const toolPath = isolated && knowledgeRelative.startsWith('knowledge-corpus') && !useLocalJunction
    ? `../../${knowledgeRelative}`
    : knowledgeRelative;
  rewriteToolPath(output, toolPath);
}

function tokenizeCommand(command: string) {
  const tokens: string[] = [];
  let token = '';
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/[;&><|\r\n`]/.test(char) || char === '$' || char === '%' || /[(){}]/.test(char)) {
      throw new Error('rg 命令包含被禁止的 shell 运算符');
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
      continue;
    }
    token += char;
  }
  if (quote) throw new Error('rg 命令引号未闭合');
  if (token) tokens.push(token);
  return tokens;
}

function isBroadMarkdownGlob(pattern: string) {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  return (
    normalized === '**/*.md'
    || normalized === '*.md'
    || normalized === '**/*'
    || normalized === '*'
    || /^knowledge-corpus\/(?:\*\*\/)?\*\.md$/i.test(normalized)
    || /^knowledge-corpus\/\*\*$/i.test(normalized)
  );
}

/** 把 glob 的 path/pattern 归一成「目录 + 相对通配」，避免双重前缀导致 No files found。 */
function normalizePatentGlobArgs(output: ToolBeforeOutput) {
  let pattern = String(output.args.pattern || output.args.glob || '*').replace(/\\/g, '/');
  let rawPath = output.args.path ?? output.args.filePath;
  const pathText = rawPath == null ? '' : String(rawPath).replace(/\\/g, '/');

  // 绝对路径 / storage 根 / "." 一律丢掉，改从 pattern 里抽 patents/...
  const pathLooksLikeRoot =
    !pathText.trim()
    || pathText === '.'
    || pathText === './'
    || /^[a-z]:\/.*\/storage\/?$/i.test(pathText)
    || /\/storage\/?$/i.test(pathText)
    || pathText === 'storage'
    || pathText === './storage';

  if (pathLooksLikeRoot) {
    rawPath = undefined;
    output.args.path = undefined;
    output.args.filePath = undefined;
  }

  const fromPattern = coercePatentRelativePath(pattern);
  if (fromPattern) {
    // pattern = patents/{id}/opencode/*  → path=patents/{id}/opencode, pattern=*
    if (pattern.includes('*') || pattern.includes('?') || pattern.includes('[')) {
      const star = pattern.search(/[*?\[]/);
      const before = pattern.slice(0, star).replace(/\/+$/, '');
      const after = pattern.slice(star);
      const dir = coercePatentRelativePath(before) || before;
      if (dir.startsWith('patents/')) {
        output.args.path = dir;
        output.args.pattern = after.startsWith('/') ? after.slice(1) : after || '*';
        if (output.args.glob !== undefined) output.args.glob = output.args.pattern;
        return true;
      }
    } else {
      output.args.path = path.posix.dirname(fromPattern);
      output.args.pattern = path.posix.basename(fromPattern);
      if (output.args.glob !== undefined) output.args.glob = output.args.pattern;
      return true;
    }
  }

  const fromPath = coercePatentRelativePath(rawPath);
  if (fromPath) {
    output.args.path = fromPath;
    // path 已是 patents/.../opencode 时，pattern 若再带同一前缀则剥掉
    const base = fromPath.replace(/\/+$/, '');
    if (pattern === base || pattern === `${base}/` || pattern === `${base}/**` || pattern === `${base}/*`) {
      output.args.pattern = pattern.endsWith('/**') ? '**/*' : '*';
    } else if (pattern.startsWith(`${base}/`)) {
      output.args.pattern = pattern.slice(base.length + 1) || '*';
    } else if (pattern.startsWith('patents/')) {
      // path 与 pattern 都是 patents/... 但 pattern 更完整
      const again = coercePatentRelativePath(pattern);
      if (again) {
        if (pattern.includes('*')) {
          const star = pattern.search(/[*?\[]/);
          output.args.path = pattern.slice(0, star).replace(/\/+$/, '');
          output.args.pattern = pattern.slice(star);
        } else {
          output.args.path = path.posix.dirname(again);
          output.args.pattern = path.posix.basename(again);
        }
      }
    }
    if (output.args.glob !== undefined) output.args.glob = output.args.pattern;
    return true;
  }

  return false;
}

function validateGlobArgs(directory: string, output: ToolBeforeOutput) {
  if (normalizePatentGlobArgs(output)) {
    const patent = resolvePatentWorkspaceTarget(directory, output.args.path);
    if (patent) {
      rewriteToolPath(output, patent.relative);
      return;
    }
  }

  const pattern = String(output.args.pattern || output.args.glob || '*').replace(/\\/g, '/');
  let rawPath = output.args.path ?? output.args.filePath;

  if ((rawPath === undefined || rawPath === null || !String(rawPath).trim()) && pattern.startsWith('knowledge-corpus/')) {
    const match = pattern.match(new RegExp(`^(knowledge-corpus(?:/(?:${DOMAIN_RE}))?)`));
    if (match) {
      rawPath = match[1];
      output.args.path = rawPath;
    }
  }

  if ((rawPath === undefined || rawPath === null || !String(rawPath).trim()) && /scheme-solve/i.test(pattern)) {
    const fromPattern = coerceSchemeSolveRelativePath(pattern);
    if (fromPattern) {
      if (pattern.includes('*') || pattern.includes('?') || pattern.includes('[')) {
        const star = pattern.search(/[*?\[]/);
        rawPath = coerceSchemeSolveRelativePath(pattern.slice(0, star).replace(/\/+$/, '')) || fromPattern;
        output.args.path = rawPath;
        output.args.pattern = pattern.slice(star) || '*';
      } else {
        rawPath = path.posix.dirname(fromPattern);
        output.args.path = rawPath === '.' ? fromPattern : rawPath;
        output.args.pattern = path.posix.basename(fromPattern);
      }
      if (output.args.glob !== undefined) output.args.glob = output.args.pattern;
    }
  }

  if (
    (rawPath === undefined || rawPath === null || !String(rawPath).trim())
    && (
      pattern.startsWith('.opencode/skills/')
      || pattern.includes('writing-source-grounded-research-reviews/')
      || pattern.includes('sgcc-tech-guide/')
    )
  ) {
    rawPath = pattern.startsWith('.opencode/skills/')
      ? path.posix.dirname(pattern)
      : `.opencode/skills/${pattern.split('/').slice(0, 2).join('/')}`;
    output.args.path = rawPath;
  }

  if (isResearchReviewWorkspacePath(directory, rawPath) || isIsolatedResearchReviewDirectory(directory)) {
    const research = resolveResearchReviewWorkspaceTarget(directory, rawPath ?? 'literature');
    if (research) {
      rewriteToolPath(output, research.relative === '.' ? 'literature' : research.relative);
      return;
    }
  }

  if (isGridGuideWorkspacePath(directory, rawPath) || isIsolatedGridGuideDirectory(directory)) {
    const gridGuide = resolveGridGuideWorkspaceTarget(directory, rawPath ?? '.');
    if (gridGuide) {
      if (gridGuide.relative === '.') {
        output.args.path = undefined;
        output.args.filePath = undefined;
      } else {
        rewriteToolPath(output, gridGuide.relative);
      }
      return;
    }
  }

  if (isSchemeSolveWorkspacePath(directory, rawPath) || isIsolatedSchemeSolveDirectory(directory)) {
    const schemeSolve = resolveSchemeSolveWorkspaceTarget(directory, rawPath ?? '.');
    if (schemeSolve) {
      if (schemeSolve.relative === '.') {
        output.args.path = undefined;
        output.args.filePath = undefined;
      } else {
        rewriteToolPath(output, schemeSolve.relative);
      }
      return;
    }
  }

  if (isPaperReproWorkspacePath(directory, rawPath) || isIsolatedPaperReproDirectory(directory)) {
    const paperRepro = resolvePaperReproWorkspaceTarget(directory, rawPath ?? '.');
    if (paperRepro) {
      if (paperRepro.relative === '.') {
        output.args.path = undefined;
        output.args.filePath = undefined;
      } else {
        rewriteToolPath(output, paperRepro.relative);
      }
      return;
    }
  }

  if (isChatWorkspacePath(directory, rawPath) || isIsolatedChatWorkspaceDirectory(directory)) {
    const chat = resolveChatWorkspaceTarget(directory, rawPath ?? '.');
    if (chat) {
      if (chat.relative === '.') {
        output.args.path = undefined;
        output.args.filePath = undefined;
      } else {
        rewriteToolPath(output, chat.relative);
      }
      return;
    }
  }

  if (isPatentWorkspacePath(directory, rawPath)) {
    const patent = resolvePatentWorkspaceTarget(directory, rawPath)!;
    rewriteToolPath(output, patent.relative);
    return;
  }

  const skill = resolveSkillTarget(directory, rawPath);
  if (skill) {
    rewriteToolPath(output, skill.knowledgeRelative);
    return;
  }

  const target = resolveCorpusTarget(directory, rawPath);
  rewriteCorpusToolPath(directory, output, target.knowledgeRelative);

  if (target.isCorpusRoot && isBroadMarkdownGlob(pattern)) {
    throw new Error(
      '禁止全库枚举 Markdown（如 knowledge-corpus/**/*.md）。请改到 papers/patents/whitepapers/projects/national-projects 等分域，用内置 grep 检索后只 read 少量文件。需要联网时用 web_search。'
    );
  }
}

function isAllowedRgPath(target: string) {
  const allowedDomain = new RegExp(`^knowledge-corpus(?:[\\\\/](?:${DOMAIN_RE}))?[\\\\/]?$`).test(target);
  const allowedRecord = new RegExp(`^knowledge-corpus[\\\\/](?:${DOMAIN_RE})[\\\\/][a-f0-9]{24}\\.md$`).test(target)
    || /^knowledge-corpus[\\/]attachments[\\/](?:[a-f0-9]{24}[\\/])?[a-f0-9]{24}\.md$/.test(target)
    || /^knowledge-corpus[\\/]MANIFEST\.md$/.test(target);
  return allowedDomain || allowedRecord;
}

/** Options that consume the following token as a value (so that value is not treated as a corpus path). */
const RG_VALUE_OPTIONS = new Set([
  '-e',
  '--regexp',
  '-g',
  '--glob',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '--iglob',
  '-m',
  '--max-count',
  '-A',
  '-B',
  '-C',
  '--context',
  '--max-filesize',
  '--max-depth',
  '--max-columns',
  '--sort',
  '--sortr',
  '--encoding',
  '-E',
  '--color',
  '--path-separator'
]);

function findRgCorpusPath(tokens: string[]) {
  const consumed = new Set<number>();
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) continue;
    const bare = token.split('=', 1)[0];
    if (token.includes('=') && token.indexOf('=') > 1) continue;
    if (RG_VALUE_OPTIONS.has(bare) && index + 1 < tokens.length) {
      consumed.add(index + 1);
    }
  }

  for (let index = tokens.length - 1; index >= 1; index -= 1) {
    if (consumed.has(index)) continue;
    const token = tokens[index];
    if (token.startsWith('-')) continue;
    if (isAllowedRgPath(token)) {
      return { index, target: token };
    }
  }
  return null;
}

function validateRipgrepCommand(directory: string, rawCommand: unknown, output?: ToolBeforeOutput) {
  if (typeof rawCommand !== 'string') throw new Error('bash command 必须是字符串');
  const tokens = tokenizeCommand(rawCommand.trim());
  if (!tokens.length || !/^rg(?:\.exe)?$/i.test(tokens[0])) {
    throw new Error('只允许执行 ripgrep (rg)');
  }
  const forbiddenOptions = [
    '--pre',
    '--pre-glob',
    '--file',
    '-f',
    '--ignore-file',
    '--type-add',
    '--type-clear',
    '--hostname-bin'
  ];
  if (tokens.some((token) => forbiddenOptions.includes(token) || token.startsWith('--pre='))) {
    throw new Error('rg 命令包含可读取外部文件或执行程序的选项');
  }
  if (tokens.some((token) => token === '..' || token.includes('../') || token.includes('..\\') || path.isAbsolute(token) || /^[a-z]:/i.test(token))) {
    throw new Error('rg 命令只能使用相对语料路径');
  }

  const found = findRgCorpusPath(tokens);
  if (!found) {
    throw new Error(
      'rg 命令必须包含语料路径，且应为 knowledge-corpus、允许的分域目录或规范 Markdown 记录。计数示例：rg --stats --count-matches --no-filename --glob "*.md" \'关键词\' knowledge-corpus/papers'
    );
  }

  const { index: pathIndex, target } = found;
  // Normalize so path is last: models often put --glob/--files-with-matches after the path.
  if (pathIndex !== tokens.length - 1 && output) {
    const next = [...tokens];
    const [pathToken] = next.splice(pathIndex, 1);
    next.push(pathToken);
    output.args.command = next
      .map((token) => (/[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token))
      .join(' ');
  }
  const isolatedCwd = ISOLATED_WORKDIR_RE.test(directory.replace(/\\/g, '/'));
  if (isolatedCwd && output && /^knowledge-corpus/i.test(target) && !hasLocalCorpusJunction(directory)) {
    const next = tokenizeCommand(String(output.args.command || rawCommand).trim());
    const again = findRgCorpusPath(next);
    if (again) {
      next[again.index] = `../../${again.target}`;
      output.args.command = next
        .map((token) => (/[\s"]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token))
        .join(' ');
    }
  }

  const isRootOnly = /^knowledge-corpus[\\/]?$/.test(target);
  const listsFiles = tokens.includes('--files-with-matches') || tokens.includes('-l') || tokens.includes('--files');
  const isStats = tokens.includes('--stats')
    || tokens.includes('--count')
    || tokens.includes('--count-matches');
  // Content/line search belongs to built-in grep. bash rg is only for counting or file lists.
  if (!isStats && !listsFiles) {
    throw new Error(
      '正文关键词与行号请用内置 grep（path 指向分域或单个 .md）；bash rg 仅允许 --stats 计数或 --files-with-matches 列文件名。'
    );
  }
  if (isRootOnly && listsFiles) {
    throw new Error(
      '禁止对整个 knowledge-corpus 根目录做 files-with-matches/文件枚举。请限定到 knowledge-corpus/papers 或 knowledge-corpus/patents 等分域，随后用 grep/read 少量命中文件。'
    );
  }

  validateCorpusPath(directory, target);
}

function truncateToolOutput(tool: string, text: string) {
  // read 不截断：阅读范围由模型自行决定。list/glob/bash/grep 仍截断，避免目录枚举撑爆上下文。
  if (tool === 'read') return text;
  const maxLines = tool === 'bash' || tool === 'glob' || tool === 'list' ? 40 : 160;
  const maxChars = tool === 'bash' || tool === 'glob' || tool === 'list' ? 5000 : 12000;
  const lines = text.split(/\r?\n/);
  let next = text;
  const notes: string[] = [];

  if (lines.length > maxLines) {
    next = `${lines.slice(0, maxLines).join('\n')}`;
    notes.push(`输出过长已截断：原 ${lines.length} 行，仅保留前 ${maxLines} 行`);
  }
  if (next.length > maxChars) {
    next = next.slice(0, maxChars);
    notes.push(`输出超过 ${maxChars} 字符已截断`);
  }
  if (!notes.length) return text;
  return `${next}\n\n【系统】${notes.join('；')}。请缩小检索范围，再用 read 打开少量候选文件，然后直接回答用户原问题。`;
}

export const CorpusGuard = async ({ directory }: { directory: string }) => ({
  'tool.execute.before': async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
    if (['read', 'grep', 'glob', 'list'].includes(input.tool)) {
      assertNotMentorCorpus(output.args.filePath ?? output.args.path ?? output.args.file);
      if (input.tool === 'glob') {
        assertNotMentorCorpus(output.args.pattern ?? output.args.glob);
      }
    }
    if (input.tool === 'bash') {
      assertNotMentorCorpus(output.args.command);
    }
    if (input.tool === 'write' || input.tool === 'edit') {
      const rawPath = output.args.filePath ?? output.args.path ?? output.args.file;
      if (isResearchReviewWorkspacePath(directory, rawPath)) {
        const research = resolveResearchReviewWorkspaceTarget(directory, rawPath)!;
        if (typeof output.args.filePath === 'string') output.args.filePath = research.relative;
        if (typeof output.args.path === 'string') output.args.path = research.relative;
        if (typeof output.args.file === 'string') output.args.file = research.relative;
        return;
      }
      if (isGridGuideWorkspacePath(directory, rawPath)) {
        const gridGuide = resolveGridGuideWorkspaceTarget(directory, rawPath)!;
        assertGridGuideWritable(gridGuide.relative);
        if (typeof output.args.filePath === 'string') output.args.filePath = gridGuide.relative;
        if (typeof output.args.path === 'string') output.args.path = gridGuide.relative;
        if (typeof output.args.file === 'string') output.args.file = gridGuide.relative;
        return;
      }
      if (isSchemeSolveWorkspacePath(directory, rawPath)) {
        const schemeSolve = resolveSchemeSolveWorkspaceTarget(directory, rawPath)!;
        if (schemeSolve.relative === '.' || schemeSolve.relative === 'scheme-solve') {
          throw new Error('禁止写入 scheme-solve 根目录；请写到具体会话或想法路径下');
        }
        if (typeof output.args.filePath === 'string') output.args.filePath = schemeSolve.relative;
        if (typeof output.args.path === 'string') output.args.path = schemeSolve.relative;
        if (typeof output.args.file === 'string') output.args.file = schemeSolve.relative;
        return;
      }
      if (isPaperReproWorkspacePath(directory, rawPath)) {
        const paperRepro = resolvePaperReproWorkspaceTarget(directory, rawPath)!;
        if (paperRepro.relative === '.' || paperRepro.relative === 'paper-repro') {
          throw new Error('禁止写入论文复现工作目录根；请写到 src/、forecast/、repro/ 或 output/');
        }
        if (isKnowledgeCorpusPathText(paperRepro.relative)) {
          throw new Error('禁止写入 knowledge-corpus/');
        }
        if (typeof output.args.filePath === 'string') output.args.filePath = paperRepro.relative;
        if (typeof output.args.path === 'string') output.args.path = paperRepro.relative;
        if (typeof output.args.file === 'string') output.args.file = paperRepro.relative;
        return;
      }
      if (isChatWorkspacePath(directory, rawPath) || isIsolatedChatWorkspaceDirectory(directory)) {
        if (isKnowledgeCorpusPathText(String(rawPath || ''))) {
          throw new Error('禁止改写 knowledge-corpus/');
        }
        const chat = resolveChatWorkspaceTarget(directory, rawPath);
        if (chat) {
          if (chat.relative === '.' || chat.relative === 'chat-workspaces') {
            throw new Error('禁止写入对话工作目录根；图表请写到 charts/');
          }
          if (isKnowledgeCorpusPathText(chat.relative)) {
            throw new Error('禁止改写 knowledge-corpus/');
          }
          if (typeof output.args.filePath === 'string') output.args.filePath = chat.relative;
          if (typeof output.args.path === 'string') output.args.path = chat.relative;
          if (typeof output.args.file === 'string') output.args.file = chat.relative;
          return;
        }
      }
      if (isChatDirectory(directory)) {
        if (isKnowledgeCorpusPathText(String(rawPath || ''))) {
          throw new Error('禁止改写 knowledge-corpus/');
        }
        if (isAllowedChatExternalPath(rawPath)) {
          return;
        }
      }
      const sharedSkill = resolveSharedSkillWriteTarget(directory, rawPath);
      if (sharedSkill) {
        if (typeof output.args.filePath === 'string') output.args.filePath = sharedSkill.relative;
        if (typeof output.args.path === 'string') output.args.path = sharedSkill.relative;
        if (typeof output.args.file === 'string') output.args.file = sharedSkill.relative;
        return;
      }
      if (!isPatentWorkspacePath(directory, rawPath)) {
        throw new Error('仅允许写入 patents/、grid-guides/、scheme-solve/、paper-repro/、chat-workspaces/ 或 .opencode/skills/shared-*');
      }
      const patent = resolvePatentWorkspaceTarget(directory, rawPath)!;
      if (typeof output.args.filePath === 'string') output.args.filePath = patent.relative;
      if (typeof output.args.path === 'string') output.args.path = patent.relative;
      if (typeof output.args.file === 'string') output.args.file = patent.relative;
      return;
    }
    if (input.tool === 'read') {
      applyIsolatedCorpusAlias(directory, output);
      const rawPath = output.args.filePath ?? output.args.path;
      if (isChatDirectory(directory) && isAllowedChatExternalPath(rawPath)) {
        return;
      }
      const target = resolveCorpusTarget(directory, rawPath);
      rewriteCorpusToolPath(directory, output, target.knowledgeRelative);
      // 阅读范围由模型自行决定：不强制 limit/offset，after 钩子也不截断 read 输出。
      return;
    }
    if (input.tool === 'glob') {
      if (isChatDirectory(directory) && isAllowedChatExternalPath(output.args.path ?? output.args.filePath)) {
        return;
      }
      if (applyIsolatedCorpusAlias(directory, output)) {
        const pattern = String(output.args.pattern || output.args.glob || '*').replace(/\\/g, '/');
        const target = resolveCorpusTarget(directory, output.args.path ?? output.args.filePath);
        if (target.isCorpusRoot && isBroadMarkdownGlob(pattern)) {
          throw new Error(
            '禁止全库枚举 Markdown（如 knowledge-corpus/**/*.md）。请改到 papers/patents/whitepapers/projects/national-projects 等分域，用内置 grep 检索后只 read 少量文件。需要联网时用 web_search。'
          );
        }
        return;
      }
      validateGlobArgs(directory, output);
      return;
    }
    if (input.tool === 'list') {
      if (isChatDirectory(directory) && isAllowedChatExternalPath(output.args.path)) {
        return;
      }
      if (applyIsolatedCorpusAlias(directory, output)) {
        const target = resolveCorpusTarget(directory, output.args.path ?? output.args.filePath);
        if (target.isCorpusRoot) {
          throw new Error('禁止 list 整个 knowledge-corpus 根目录；请 list 具体分域或直接检索。');
        }
        return;
      }
      let listPath = output.args.path;
      const listPathText = listPath == null ? '' : String(listPath).replace(/\\/g, '/');
      // 绝对 storage 根 / "." 且 pattern 含 patents 时，纠到 patents 工作区
      if (
        (!listPathText.trim() || listPathText === '.' || /\/storage\/?$/i.test(listPathText) || listPathText === 'storage')
        && typeof output.args.pattern === 'string'
        && String(output.args.pattern).includes('patents/')
      ) {
        const fromPattern = coercePatentRelativePath(output.args.pattern);
        listPath = fromPattern ? fromPattern.replace(/\/[^/]*\*.*$/, '') || 'patents' : 'patents';
        output.args.path = listPath;
      }
      if (isResearchReviewWorkspacePath(directory, listPath) || isIsolatedResearchReviewDirectory(directory)) {
        const research = resolveResearchReviewWorkspaceTarget(directory, listPath ?? '.');
        if (research) {
          output.args.path = research.relative === '.' ? undefined : research.relative;
          if (output.args.path === undefined) output.args.path = 'literature';
          return;
        }
      }
      if (isGridGuideWorkspacePath(directory, listPath) || isIsolatedGridGuideDirectory(directory)) {
        const gridGuide = resolveGridGuideWorkspaceTarget(directory, listPath ?? '.');
        if (gridGuide) {
          output.args.path = gridGuide.relative === '.' ? undefined : gridGuide.relative;
          return;
        }
      }
      if (isSchemeSolveWorkspacePath(directory, listPath) || isIsolatedSchemeSolveDirectory(directory)) {
        const schemeSolve = resolveSchemeSolveWorkspaceTarget(directory, listPath ?? '.');
        if (schemeSolve) {
          output.args.path = schemeSolve.relative === '.' ? undefined : schemeSolve.relative;
          return;
        }
      }
      if (isPaperReproWorkspacePath(directory, listPath) || isIsolatedPaperReproDirectory(directory)) {
        const paperRepro = resolvePaperReproWorkspaceTarget(directory, listPath ?? '.');
        if (paperRepro) {
          output.args.path = paperRepro.relative === '.' ? undefined : paperRepro.relative;
          return;
        }
      }
      if (isChatWorkspacePath(directory, listPath) || isIsolatedChatWorkspaceDirectory(directory)) {
        const chat = resolveChatWorkspaceTarget(directory, listPath ?? '.');
        if (chat) {
          output.args.path = chat.relative === '.' ? undefined : chat.relative;
          return;
        }
      }
      if (isPatentWorkspacePath(directory, listPath) || (listPath && String(listPath).replace(/\\/g, '/').startsWith('patents'))) {
        const normalized = String(listPath).replace(/\\/g, '/').replace(/^\.\//, '');
        const patentRoot = normalized === 'patents' || normalized === 'patents/'
          ? 'patents'
          : (resolvePatentWorkspaceTarget(directory, listPath)?.relative || normalized);
        output.args.path = patentRoot;
        return;
      }
      const skill = resolveSkillTarget(directory, listPath);
      if (skill) {
        rewriteToolPath(output, skill.knowledgeRelative);
        return;
      }
      const target = resolveCorpusTarget(directory, listPath);
      rewriteCorpusToolPath(directory, output, target.knowledgeRelative);
      if (target.isCorpusRoot) {
        throw new Error('禁止 list 整个 knowledge-corpus 根目录；请 list 具体分域或直接检索。');
      }
      return;
    }
    if (input.tool === 'grep') {
      if (isChatDirectory(directory) && isAllowedChatExternalPath(output.args.path ?? output.args.filePath)) {
        return;
      }
      if (applyIsolatedCorpusAlias(directory, output)) {
        const target = resolveCorpusTarget(directory, output.args.path ?? output.args.filePath);
        const normalizedPath = target.knowledgeRelative.replace(/\/+$/, '');
        if (normalizedPath === 'knowledge-corpus') {
          throw new Error(
            '禁止对 knowledge-corpus 根目录做全文 grep；请把 path 限定到 papers/patents/whitepapers/projects/national-projects 等分域，或单个 .md 文件。需要联网时用 web_search。'
          );
        }
        return;
      }
      if (isResearchReviewWorkspacePath(directory, output.args.path) || isIsolatedResearchReviewDirectory(directory)) {
        const research = resolveResearchReviewWorkspaceTarget(directory, output.args.path ?? 'literature');
        if (research) {
          rewriteToolPath(output, research.relative === '.' ? 'literature' : research.relative);
          return;
        }
      }
      if (isGridGuideWorkspacePath(directory, output.args.path) || isIsolatedGridGuideDirectory(directory)) {
        const gridGuide = resolveGridGuideWorkspaceTarget(directory, output.args.path ?? '.');
        if (gridGuide) {
          if (gridGuide.relative === '.') {
            output.args.path = undefined;
            output.args.filePath = undefined;
          } else {
            rewriteToolPath(output, gridGuide.relative);
          }
          return;
        }
      }
      if (isSchemeSolveWorkspacePath(directory, output.args.path) || isIsolatedSchemeSolveDirectory(directory)) {
        const schemeSolve = resolveSchemeSolveWorkspaceTarget(directory, output.args.path ?? '.');
        if (schemeSolve) {
          if (schemeSolve.relative === '.') {
            output.args.path = undefined;
            output.args.filePath = undefined;
          } else {
            rewriteToolPath(output, schemeSolve.relative);
          }
          return;
        }
      }
      if (isPaperReproWorkspacePath(directory, output.args.path) || isIsolatedPaperReproDirectory(directory)) {
        const paperRepro = resolvePaperReproWorkspaceTarget(directory, output.args.path ?? '.');
        if (paperRepro) {
          if (paperRepro.relative === '.') {
            output.args.path = undefined;
            output.args.filePath = undefined;
          } else {
            rewriteToolPath(output, paperRepro.relative);
          }
          return;
        }
      }
      if (isChatWorkspacePath(directory, output.args.path) || isIsolatedChatWorkspaceDirectory(directory)) {
        const chat = resolveChatWorkspaceTarget(directory, output.args.path ?? '.');
        if (chat) {
          if (chat.relative === '.') {
            output.args.path = undefined;
            output.args.filePath = undefined;
          } else {
            rewriteToolPath(output, chat.relative);
          }
          return;
        }
      }
      if (isPatentWorkspacePath(directory, output.args.path)) {
        const patent = resolvePatentWorkspaceTarget(directory, output.args.path)!;
        rewriteToolPath(output, patent.relative);
        return;
      }
      const target = resolveCorpusTarget(directory, output.args.path);
      rewriteCorpusToolPath(directory, output, target.knowledgeRelative);
      const normalizedPath = target.knowledgeRelative.replace(/\/+$/, '');
      // Only block unanchored grep on the corpus root. Domain / file greps are the
      // preferred path — forcing bash rg caused failed pipes and tool thrashing.
      if (normalizedPath === 'knowledge-corpus') {
        throw new Error(
          '禁止对 knowledge-corpus 根目录做全文 grep；请把 path 限定到 papers/patents/whitepapers/projects/national-projects 等分域，或单个 .md 文件。需要联网时用 web_search。'
        );
      }
      return;
    }
    if (input.tool === 'bash') {
      if (isChatDirectory(directory)) {
        assertNotMentorCorpus(output.args.command);
        return;
      }
      if (isIsolatedGridGuideDirectory(directory)) {
        assertNotMentorCorpus(output.args.command);
        const workdir = output.args.workdir;
        if (workdir !== undefined && workdir !== null && String(workdir).trim()) {
          const resolvedWorkdir = path.resolve(directory, String(workdir));
          if (!isUnder(path.resolve(directory), resolvedWorkdir)) {
            throw new Error('bash 工作目录必须在国网指南隔离目录内');
          }
        }
        const command = String(output.args.command || '').trim();
        if (/^(rg(?:\.exe)?|python(?:3)?(?:\.exe)?)\b/i.test(command)) {
          return;
        }
        throw new Error('国网指南工作区只允许执行 ripgrep (rg) 或 python');
      }
      if (isIsolatedPaperReproDirectory(directory)) {
        assertNotMentorCorpus(output.args.command);
        const workdir = output.args.workdir;
        if (workdir !== undefined && workdir !== null && String(workdir).trim()) {
          const resolvedWorkdir = path.resolve(directory, String(workdir));
          if (!isUnder(path.resolve(directory), resolvedWorkdir)) {
            throw new Error('bash 工作目录必须在论文复现隔离目录内');
          }
        }
        return;
      }
      const workdir = output.args.workdir;
      if (workdir !== undefined && workdir !== null && String(workdir).trim()) {
        const resolvedWorkdir = path.resolve(directory, String(workdir));
        if (resolvedWorkdir !== path.resolve(directory)) {
          throw new Error('rg 命令不允许切换工作目录');
        }
      }
      const command = String(output.args.command || '');
      if (/\bpatents\//.test(command) && !/\bknowledge-corpus\//.test(command)) {
        // Allow rg over patent workspace without corpus path requirements.
        if (!/^rg(?:\.exe)?\b/i.test(command.trim())) {
          throw new Error('只允许执行 ripgrep (rg)');
        }
        return;
      }
      validateRipgrepCommand(directory, output.args.command, output);
    }
  },
  'tool.execute.after': async (input: ToolAfterInput, output: ToolAfterOutput) => {
    if (!output || typeof output.output !== 'string') return;
    if (!['bash', 'glob', 'list', 'grep'].includes(input.tool)) return;
    output.output = truncateToolOutput(input.tool, output.output);
  }
});

export default CorpusGuard;
