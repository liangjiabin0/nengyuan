'use client';

import Link from 'next/link';
import {
  type DragEvent as ReactDragEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { useNotifyError, useNotifySuccess } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { cn } from '@/lib/utils';
import {
  canDeleteSharedSkill,
  canEditSharedSkill,
  skillDeleteDeniedReason
} from '@/lib/skill-permissions';

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 1024;
const BODY_MAX = 24_000;
const DEFAULT_BODY = `# 技能名称

## 步骤

1. 
`;

type SharedSkill = {
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

type EditorState = {
  mode: 'create' | 'edit' | 'view';
  skill?: SharedSkill;
};

function formatDate(value: string) {
  if (!value) return '—';
  return value.slice(0, 16).replace('T', ' ');
}

function suggestSkillKey(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function skillActor(userId?: string | null, isAdmin?: boolean) {
  return { id: userId, role: isAdmin ? 'admin' : undefined };
}

function skillCanEdit(skill: SharedSkill, userId?: string | null, isAdmin?: boolean) {
  return canEditSharedSkill(skill, skillActor(userId, isAdmin));
}

function skillCanDelete(skill: SharedSkill, userId?: string | null, isAdmin?: boolean) {
  return canDeleteSharedSkill(skill, skillActor(userId, isAdmin));
}

const FILE_CONTENT_MAX = 1_000_000;

type SkillFileEntry = {
  path: string;
  size: number;
  binary: boolean;
};

type FileDraft = {
  content: string;
  loaded: boolean;
  dirty: boolean;
  binary: boolean;
  tooLarge: boolean;
  isNew: boolean;
};

type TreeNode = {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  binary?: boolean;
  children: TreeNode[];
};

function formatFileSize(size: number) {
  if (!size) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeClientPath(input: string) {
  const relative = input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!relative) throw new Error('请填写文件路径。');
  if (relative.length > 240) throw new Error('文件路径过长。');
  const parts = relative.split('/');
  if (parts.length > 12) throw new Error('文件路径过深。');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.startsWith('.')) throw new Error('文件路径无效。');
    if (part !== part.trim() || /[<>:"|?*\u0000-\u001f]/.test(part)) throw new Error('文件路径含有非法字符。');
  }
  if (parts[parts.length - 1]!.toLowerCase() === 'skill.md') throw new Error('SKILL.md 已经存在。');
  return parts.join('/');
}

function buildFileTree(files: SkillFileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    if (!parts.length) continue;
    let level = root;
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      const nodePath = parts.slice(0, index + 1).join('/');
      let node = level.find((item) => item.name === part && item.kind === (isFile ? 'file' : 'dir'));
      if (!node) {
        node = {
          name: part,
          path: nodePath,
          kind: isFile ? 'file' : 'dir',
          binary: isFile ? file.binary : undefined,
          children: []
        };
        level.push(node);
      }
      level = node.children;
    });
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      if (a.path === 'SKILL.md') return -1;
      if (b.path === 'SKILL.md') return 1;
      return a.name.localeCompare(b.name, 'zh');
    });
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(root);
  return root;
}

function SkillFileTree({
  nodes,
  depth,
  activePath,
  collapsed,
  dirtyPaths,
  onToggle,
  onOpen
}: {
  nodes: TreeNode[];
  depth: number;
  activePath: string;
  collapsed: Set<string>;
  dirtyPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <ul role={depth === 0 ? 'tree' : 'group'} className={depth ? 'ml-3 border-l border-border/80 pl-1' : 'space-y-0.5'}>
      {nodes.map((node) => {
        if (node.kind === 'dir') {
          const open = !collapsed.has(node.path);
          return (
            <li key={node.path} role="treeitem" aria-expanded={open}>
              <button
                type="button"
                onClick={() => onToggle(node.path)}
                className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs text-foreground hover:bg-accent"
              >
                {open ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
                {open
                  ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  : <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="truncate">{node.name}</span>
              </button>
              {open ? (
                <SkillFileTree
                  nodes={node.children}
                  depth={depth + 1}
                  activePath={activePath}
                  collapsed={collapsed}
                  dirtyPaths={dirtyPaths}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              ) : null}
            </li>
          );
        }
        const selected = node.path === activePath;
        return (
          <li key={node.path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-current={selected ? 'true' : undefined}
              onClick={() => onOpen(node.path)}
              className={cn(
                'flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-xs',
                selected
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
              )}
              title={node.binary ? `${node.path}（二进制）` : node.path}
            >
              <FileText className="ml-4 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {dirtyPaths.has(node.path) ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="未保存" />
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SkillEditorDialog({
  state,
  canDelete,
  deleteDisabledReason,
  currentUserId,
  onClose,
  onSaved,
  onDeleted
}: {
  state: EditorState;
  canDelete: boolean;
  deleteDisabledReason?: string | null;
  currentUserId?: string | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const readOnly = state.mode === 'view';
  const [title, setTitle] = useState(state.skill?.title || '');
  const [name, setName] = useState(state.skill?.name || '');
  const [description, setDescription] = useState(state.skill?.description || '');
  const [body, setBody] = useState(state.mode === 'create' ? DEFAULT_BODY : '');
  const [nameTouched, setNameTouched] = useState(Boolean(state.skill?.name));
  const [loading, setLoading] = useState(state.mode !== 'create');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [entries, setEntries] = useState<SkillFileEntry[]>([{ path: 'SKILL.md', size: 0, binary: false }]);
  const [drafts, setDrafts] = useState<Record<string, FileDraft>>({});
  const [deletedPaths, setDeletedPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState('SKILL.md');
  const [fileLoading, setFileLoading] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newPathError, setNewPathError] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [, setError] = useNotifyError();
  const initialRef = useRef({ title: '', name: '', description: '', body: '' });
  const draftsRef = useRef(drafts);
  const fileRequestRef = useRef(0);
  draftsRef.current = drafts;

  useEffect(() => {
    if (state.mode === 'create') {
      initialRef.current = { title: '', name: '', description: '', body: DEFAULT_BODY };
      return;
    }
    if (!state.skill) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`/api/skills/${encodeURIComponent(state.skill.id)}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as {
          skill?: SharedSkill;
          body?: string;
          files?: Array<SkillFileEntry | string>;
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || '加载技能失败');
        if (cancelled) return;
        const nextTitle = payload.skill?.title || state.skill?.title || '';
        const nextName = payload.skill?.name || state.skill?.name || '';
        const nextDescription = payload.skill?.description || state.skill?.description || '';
        const nextBody = payload.body || '';
        const nextFiles = (payload.files || []).map((file) => (
          typeof file === 'string' ? { path: file, size: 0, binary: false } : file
        )).filter((file) => file.path);
        if (!nextFiles.some((file) => file.path === 'SKILL.md')) {
          nextFiles.unshift({ path: 'SKILL.md', size: 0, binary: false });
        }
        setTitle(nextTitle);
        setName(nextName);
        setDescription(nextDescription);
        setBody(nextBody);
        setEntries(nextFiles);
        setDrafts({});
        setDeletedPaths([]);
        setActivePath('SKILL.md');
        setCollapsed(new Set());
        setNameTouched(true);
        initialRef.current = {
          title: nextTitle,
          name: nextName,
          description: nextDescription,
          body: nextBody
        };
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载技能失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [state.mode, state.skill]);

  const dirty = title !== initialRef.current.title
    || name !== initialRef.current.name
    || description !== initialRef.current.description
    || body !== initialRef.current.body;
  const filesDirty = deletedPaths.length > 0 || Object.values(drafts).some((draft) => draft.dirty);
  const unsaved = dirty || filesDirty;

  const visibleFiles = useMemo(() => {
    const map = new Map<string, SkillFileEntry>();
    for (const entry of entries) {
      if (!deletedPaths.includes(entry.path)) map.set(entry.path, entry);
    }
    for (const [filePath, draft] of Object.entries(drafts)) {
      if (draft.isNew && !deletedPaths.includes(filePath)) {
        map.set(filePath, { path: filePath, size: draft.content.length, binary: false });
      }
    }
    if (!map.has('SKILL.md')) map.set('SKILL.md', { path: 'SKILL.md', size: body.length, binary: false });
    return [...map.values()];
  }, [body.length, deletedPaths, drafts, entries]);
  const fileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);
  const dirtyPaths = useMemo(() => {
    const paths = new Set<string>();
    if (dirty) paths.add('SKILL.md');
    for (const [filePath, draft] of Object.entries(drafts)) {
      if (draft.dirty) paths.add(filePath);
    }
    return paths;
  }, [dirty, drafts]);

  function requestClose() {
    if (readOnly || !unsaved || saving || deleting) {
      onClose();
      return;
    }
    if (window.confirm('放弃未保存的修改？')) onClose();
  }

  async function openFile(nextPath: string) {
    setActivePath(nextPath);
    if (nextPath === 'SKILL.md') return;
    const existing = draftsRef.current[nextPath];
    if (existing?.loaded || existing?.isNew) return;
    const known = entries.find((entry) => entry.path === nextPath);
    if (known?.binary) {
      setDrafts((current) => ({
        ...current,
        [nextPath]: {
          content: '',
          loaded: true,
          dirty: false,
          binary: true,
          tooLarge: false,
          isNew: false
        }
      }));
      return;
    }
    if (!state.skill) return;
    const requestId = fileRequestRef.current + 1;
    fileRequestRef.current = requestId;
    setFileLoading(true);
    setError('');
    try {
      const response = await fetch(
        `/api/skills/${encodeURIComponent(state.skill.id)}?file=${encodeURIComponent(nextPath)}`
      );
      const payload = await response.json().catch(() => ({})) as {
        file?: { content?: string | null; binary?: boolean; tooLarge?: boolean };
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || '读取文件失败');
      if (fileRequestRef.current !== requestId) return;
      const file = payload.file;
      setDrafts((current) => ({
        ...current,
        [nextPath]: {
          content: file?.content || '',
          loaded: true,
          dirty: false,
          binary: Boolean(file?.binary),
          tooLarge: Boolean(file?.tooLarge),
          isNew: false
        }
      }));
    } catch (err) {
      if (fileRequestRef.current === requestId) {
        setError(err instanceof Error ? err.message : '读取文件失败');
      }
    } finally {
      if (fileRequestRef.current === requestId) setFileLoading(false);
    }
  }

  async function remove() {
    if (!state.skill || !canDelete || deleting || saving) return;
    if (!window.confirm(`删除「${title || state.skill.title || state.skill.name}」？此操作不可恢复。`)) return;
    setDeleting(true);
    setError('');
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(state.skill.id)}`, { method: 'DELETE' });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || '删除失败');
      await onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  function changedFiles() {
    return Object.entries(drafts)
      .filter(([filePath, draft]) => draft.dirty && !draft.binary && !draft.tooLarge && !deletedPaths.includes(filePath))
      .map(([filePath, draft]) => ({ path: filePath, content: draft.content }));
  }

  function addFile() {
    if (readOnly) return;
    setNewPathError('');
    let relative = '';
    try {
      relative = normalizeClientPath(newPath);
    } catch (err) {
      setNewPathError(err instanceof Error ? err.message : '文件路径无效。');
      return;
    }
    if (visibleFiles.some((file) => file.path === relative)) {
      setNewPathError('这个文件已经存在。');
      return;
    }
    setDrafts((current) => ({
      ...current,
      [relative]: {
        content: '',
        loaded: true,
        dirty: true,
        binary: false,
        tooLarge: false,
        isNew: true
      }
    }));
    setCollapsed((current) => {
      const next = new Set(current);
      const parts = relative.split('/');
      for (let index = 1; index < parts.length; index += 1) next.delete(parts.slice(0, index).join('/'));
      return next;
    });
    setActivePath(relative);
    setNewPath('');
  }

  function removeActiveFile() {
    if (readOnly || activePath === 'SKILL.md' || saving || deleting) return;
    if (!window.confirm(`从技能里删除「${activePath}」？保存后才会生效。`)) return;
    const draft = drafts[activePath];
    if (!draft?.isNew) {
      setDeletedPaths((current) => current.includes(activePath) ? current : [...current, activePath]);
    }
    setDrafts((current) => {
      const next = { ...current };
      delete next[activePath];
      return next;
    });
    setActivePath('SKILL.md');
  }

  async function save() {
    if (readOnly || saving) return;
    const files = changedFiles();
    const removed = deletedPaths.filter((filePath) => filePath !== 'SKILL.md');
    if (!dirty && !files.length && !removed.length) return;
    setSaving(true);
    setError('');
    try {
      const meta = {
        title: title.trim(),
        name: name.trim(),
        description: description.trim(),
        body: body.trim()
      };
      if (state.mode === 'create') {
        let skillId = createdId;
        if (!skillId) {
          const response = await fetch('/api/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meta)
          });
          const result = await response.json().catch(() => ({})) as { skill?: { id: string }; error?: string };
          if (!response.ok || !result.skill?.id) throw new Error(result.error || '保存失败');
          skillId = result.skill.id;
          setCreatedId(skillId);
        }
        if (files.length || removed.length || (createdId && dirty)) {
          const follow = await fetch(`/api/skills/${encodeURIComponent(skillId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createdId && dirty ? { ...meta, files, deleted: removed } : { files, deleted: removed })
          });
          const followResult = await follow.json().catch(() => ({})) as { error?: string };
          if (!follow.ok) throw new Error(followResult.error || '附加文件保存失败');
        }
      } else {
        const payload = dirty ? { ...meta, files, deleted: removed } : { files, deleted: removed };
        const response = await fetch(`/api/skills/${encodeURIComponent(state.skill!.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(result.error || '保存失败');
      }
      await onSaved(state.mode === 'create' ? '已创建技能' : '已保存技能');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!readOnly) void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly, unsaved, saving, title, name, description, body, drafts, deletedPaths, createdId]);

  const heading = state.mode === 'create'
    ? '新建技能'
    : readOnly
      ? (state.skill?.title || state.skill?.name || '查看技能')
      : '编辑技能';

  const sourceLabel = state.skill?.source === 'system'
    ? '系统'
    : state.skill && currentUserId && state.skill.uploadedBy === currentUserId
      ? '自己上传'
      : state.skill
        ? '共享'
        : '新建';

  return (
    <div className="rag-evidence-modal-backdrop" onClick={requestClose}>
      <div
        className="rag-evidence-modal rag-skill-editor"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{heading}</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {readOnly
                ? '没有修改权限，只能查看。左侧是这个技能的全部文件。'
                : '左侧是文件树。SKILL.md 写名称、描述和正文，其他文本文件可以直接改，Ctrl+S 保存。'}
            </p>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving || deleting}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            aria-label="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {loading ? (
          <p className="flex-1 px-5 py-12 text-center text-xs text-muted-foreground">加载中…</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="scrollbar-thin flex max-h-56 min-h-0 w-full shrink-0 flex-col border-b border-border bg-muted/30 md:max-h-none md:w-72 md:border-b-0 md:border-r">
              <div className="flex items-center justify-between px-3 pb-1 pt-3">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                  文件
                </div>
                <span className="text-[11px] text-muted-foreground">{visibleFiles.length}</span>
              </div>
              <div className="scrollbar-thin min-h-0 flex-1 overflow-auto px-2 pb-2">
                <SkillFileTree
                  nodes={fileTree}
                  depth={0}
                  activePath={activePath}
                  collapsed={collapsed}
                  dirtyPaths={dirtyPaths}
                  onToggle={(dir) => {
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(dir)) next.delete(dir);
                      else next.add(dir);
                      return next;
                    });
                  }}
                  onOpen={(filePath) => { void openFile(filePath); }}
                />
              </div>
              {readOnly ? null : (
                <form
                  className="space-y-1 border-t border-border px-3 py-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addFile();
                  }}
                >
                  <div className="flex items-center gap-1">
                    <input
                      value={newPath}
                      onChange={(event) => {
                        setNewPath(event.target.value);
                        if (newPathError) setNewPathError('');
                      }}
                      placeholder="references/note.md"
                      className="ui-input h-8 min-w-0 flex-1 bg-background font-mono text-[12px]"
                      aria-label="新文件路径"
                    />
                    <button type="submit" className="ui-btn-secondary h-8 shrink-0 gap-1 px-2 text-xs">
                      <FilePlus className="h-3.5 w-3.5" />
                      添加
                    </button>
                  </div>
                  {newPathError ? <p className="text-[11px] text-destructive">{newPathError}</p> : null}
                </form>
              )}
            </aside>

            <section className="flex min-h-0 min-w-0 flex-1 flex-col">
              {activePath === 'SKILL.md' ? (
                <div className="scrollbar-thin grid shrink-0 gap-3 overflow-auto border-b border-border px-5 py-3 md:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">名称</span>
                    <input
                      value={title}
                      maxLength={TITLE_MAX}
                      disabled={readOnly}
                      onChange={(event) => {
                        const next = event.target.value;
                        setTitle(next);
                        if (!nameTouched) setName(suggestSkillKey(next));
                      }}
                      placeholder="例如：代码审查"
                      className="ui-input h-8 bg-background"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-foreground">标识</span>
                    <input
                      value={name}
                      disabled={readOnly || state.skill?.source === 'system'}
                      onChange={(event) => {
                        setNameTouched(true);
                        setName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
                      }}
                      placeholder="可留空，保存时自动生成"
                      className="ui-input h-8 bg-background font-mono text-[13px]"
                    />
                  </label>
                  <label className="block space-y-1 md:col-span-2">
                    <span className="text-xs font-medium text-foreground">描述</span>
                    <textarea
                      value={description}
                      maxLength={DESCRIPTION_MAX}
                      disabled={readOnly}
                      rows={2}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="写清做什么、什么时候用。模型靠这段描述判断要不要加载。"
                      className="ui-input min-h-[3.5rem] resize-y bg-background leading-5"
                    />
                    <span className="block text-[11px] text-muted-foreground">
                      {state.skill ? `${sourceLabel} · ${state.skill.uploadedByName || '—'} · ` : ''}
                      {description.length}/{DESCRIPTION_MAX}
                    </span>
                  </label>
                </div>
              ) : null}

              <div className="flex min-h-0 flex-1 flex-col px-5 py-3">
                <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
                  <div className="min-w-0">
                    <code className="block truncate text-[12px] text-foreground">{activePath}</code>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {activePath === 'SKILL.md'
                        ? `正文会写进 SKILL.md。${body.length}/${BODY_MAX}`
                        : drafts[activePath]?.binary
                          ? `二进制文件，${formatFileSize(visibleFiles.find((file) => file.path === activePath)?.size || 0)}`
                          : drafts[activePath]?.tooLarge
                            ? '文件超过 1 MB，不能在这里打开。'
                            : '文本文件，保存后写回技能目录。'}
                    </p>
                  </div>
                  {readOnly || activePath === 'SKILL.md' ? null : (
                    <button
                      type="button"
                      onClick={removeActiveFile}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除文件
                    </button>
                  )}
                </div>
                {activePath === 'SKILL.md' ? (
                  <textarea
                    value={body}
                    maxLength={BODY_MAX}
                    disabled={readOnly}
                    spellCheck={false}
                    onChange={(event) => setBody(event.target.value)}
                    placeholder={DEFAULT_BODY}
                    className="ui-input min-h-[12rem] flex-1 resize-none bg-background font-mono text-[13px] leading-6"
                  />
                ) : fileLoading && !drafts[activePath]?.loaded ? (
                  <p className="px-1 py-8 text-center text-xs text-muted-foreground">正在读取…</p>
                ) : drafts[activePath]?.binary || drafts[activePath]?.tooLarge ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                    {drafts[activePath]?.binary
                      ? '这是二进制文件，可以在文件树里看到，但不能在这里编辑。'
                      : '文件太大，不能在编辑器里打开。'}
                  </p>
                ) : (
                  <textarea
                    value={drafts[activePath]?.content || ''}
                    maxLength={FILE_CONTENT_MAX}
                    disabled={readOnly || !drafts[activePath]?.loaded}
                    spellCheck={false}
                    onChange={(event) => {
                      const content = event.target.value;
                      setDrafts((current) => ({
                        ...current,
                        [activePath]: {
                          content,
                          loaded: true,
                          dirty: true,
                          binary: false,
                          tooLarge: false,
                          isNew: current[activePath]?.isNew || false
                        }
                      }));
                    }}
                    className="ui-input min-h-[12rem] flex-1 resize-none bg-background font-mono text-[13px] leading-6"
                  />
                )}
              </div>
            </section>
          </div>
        )}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3">
          <div>
            {state.skill ? (
              <button
                type="button"
                onClick={() => void remove()}
                disabled={!canDelete || saving || deleting}
                className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
                title={canDelete ? '删除技能' : (deleteDisabledReason || '没有删除权限')}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {deleting ? '正在删除…' : '删除技能'}
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={requestClose}
              disabled={saving || deleting}
              className="ui-btn-secondary h-8 px-3 text-xs"
            >
              {readOnly ? '关闭' : '取消'}
            </button>
            {readOnly ? null : (
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || deleting || loading || !unsaved}
                className="ui-btn-primary h-8 px-3 text-xs"
              >
                {saving ? '保存中…' : state.mode === 'create' ? '创建技能' : '保存'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SkillLibrary() {
  const { user, isAdmin } = useAuth();
  const [skills, setSkills] = useState<SharedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [, setError] = useNotifyError();
  const [, setMessage] = useNotifySuccess();
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'mine' | 'system'>('all');
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SharedSkill | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  usePageContentReady(!loading);

  async function loadSkills() {
    const response = await fetch('/api/skills');
    const payload = await response.json().catch(() => ({})) as {
      skills?: SharedSkill[];
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error || '加载技能库失败');
    setSkills(payload.skills || []);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadSkills()
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载技能库失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = skills.filter((skill) => {
      if (sourceFilter === 'system' && skill.source !== 'system') return false;
      if (sourceFilter === 'mine' && (skill.source === 'system' || skill.uploadedBy !== user?.id)) return false;
      if (!q) return true;
      return (
        skill.title.toLowerCase().includes(q)
        || skill.name.toLowerCase().includes(q)
        || skill.description.toLowerCase().includes(q)
        || skill.uploadedByName.toLowerCase().includes(q)
      );
    });
    rows.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    return rows;
  }, [query, skills, sourceFilter, user?.id]);

  function openSkill(skill: SharedSkill) {
    setEditor({
      mode: skillCanEdit(skill, user?.id, isAdmin) ? 'edit' : 'view',
      skill
    });
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setUploading(true);
    setError('');
    setMessage('');
    let published = 0;
    try {
      for (const file of list) {
        const form = new FormData();
        form.append('file', file);
        const response = await fetch('/api/skills', { method: 'POST', body: form });
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(payload.error || `上传 ${file.name} 失败`);
        published += 1;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '技能上传失败');
    } finally {
      if (published > 0) {
        try {
          await loadSkills();
          setMessage(published === 1 ? '已发布' : `已发布 ${published} 个技能`);
        } catch (refreshError) {
          const detail = refreshError instanceof Error ? refreshError.message : '刷新技能库失败';
          setError((current) => current ? `${current}；${detail}` : detail);
        }
      }
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    fileInputRef.current?.click();
  }

  function onDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (event.dataTransfer.types.includes('Files')) setDragging(true);
  }

  function onDragOver(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }

  function onDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    if (event.dataTransfer.files?.length) void uploadFiles(event.dataTransfer.files);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(pendingDelete.id)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || '删除失败');
      setSkills((current) => current.filter((item) => item.id !== pendingDelete.id));
      setMessage('已删除');
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className="rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border border-dashed border-border bg-background/90 md:inset-4">
          <p className="text-sm text-muted-foreground">松开以上传</p>
        </div>
      ) : null}

      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Dashboard / Skills
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">技能库</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          列出对话里可独立完成一项工作的技能。专利流水线、国网指南、综述等页面内置步骤，以及自学习记忆，不会出现在这里。
        </p>
      </div>

      <div className="rag-chat-card min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索"
              className="ui-input h-8 pl-8 text-xs"
            />
          </div>
          <div className="flex items-center rounded-md border border-border p-0.5" role="tablist" aria-label="技能来源">
            {([
              { id: 'all', label: '全部' },
              { id: 'mine', label: '自己上传' },
              { id: 'system', label: '系统' }
            ] as const).map((item) => {
              const active = sourceFilter === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSourceFilter(item.id)}
                  className={cn(
                    'h-7 rounded px-2 text-xs transition',
                    active
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <Link
            href="/self-learning"
            className="ui-btn-secondary h-8 gap-1 px-2.5 text-xs"
          >
            <BrainCircuit className="h-3.5 w-3.5" />
            自学习记忆
          </Link>
          <button
            type="button"
            onClick={() => setEditor({ mode: 'create' })}
            className="ui-btn-primary h-8 gap-1 px-2.5 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            新建技能
          </button>
          <form onSubmit={onSubmit}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.zip"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files?.length) void uploadFiles(event.target.files);
              }}
            />
            <button type="submit" disabled={uploading} className="ui-btn-secondary h-8 gap-1 px-2.5 text-xs">
              <Upload className="h-3.5 w-3.5" />
              {uploading ? '上传中…' : '上传'}
            </button>
          </form>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col />
              <col className="w-16" />
              <col className="hidden w-72 md:table-column" />
              <col className="w-28" />
              <col className="hidden w-[7rem] sm:table-column" />
              <col className="w-[8.75rem]" />
            </colgroup>
            <thead className="sticky top-0 z-10 border-b border-border bg-muted">
              <tr className="text-left text-[11px] font-medium text-muted-foreground">
                <th className="px-3 py-2 font-medium">名称</th>
                <th className="w-16 px-3 py-2 font-medium">来源</th>
                <th className="hidden w-72 px-3 py-2 font-medium md:table-cell">说明</th>
                <th className="w-28 px-3 py-2 font-medium">发布者</th>
                <th className="hidden w-[7rem] whitespace-nowrap px-2 py-2 font-medium sm:table-cell">时间</th>
                <th className="w-[8.75rem] whitespace-nowrap px-2 py-2 pr-3" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                    <td colSpan={6} className="px-3 py-12 text-center text-xs text-muted-foreground">
                    加载中…
                  </td>
                </tr>
              ) : filtered.length ? (
                filtered.map((skill) => {
                  const mine = Boolean(user?.id) && skill.uploadedBy === user?.id;
                  const canDelete = skillCanDelete(skill, user?.id, isAdmin);
                  const canEdit = skillCanEdit(skill, user?.id, isAdmin);
                  return (
                    <tr
                      key={skill.id}
                      className="cursor-pointer border-b border-border/70 last:border-b-0 hover:bg-muted/50"
                      onClick={() => openSkill(skill)}
                    >
                      <td className="px-3 py-2" title={skill.title || skill.name}>
                        <span className="block truncate text-[13px] font-medium text-foreground">
                          {skill.title || skill.name}
                        </span>
                        <code className="mt-0.5 block truncate text-[11px] text-muted-foreground">{skill.name}</code>
                      </td>
                      <td className="px-3 py-2">
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {skill.source === 'system' ? '系统' : mine ? '自己上传' : '共享'}
                        </span>
                      </td>
                      <td className="hidden truncate px-3 py-2 text-xs text-muted-foreground md:table-cell" title={skill.description || ''}>
                        {skill.description || '—'}
                      </td>
                      <td className="truncate px-3 py-2 text-xs text-muted-foreground">
                        {skill.uploadedByName || '—'}
                      </td>
                      <td className="hidden whitespace-nowrap px-2 py-2 text-xs tabular-nums text-muted-foreground sm:table-cell">
                        {formatDate(skill.updatedAt || skill.createdAt)}
                      </td>
                      <td
                        className="w-[8.75rem] whitespace-nowrap px-2 py-2 pr-3 text-right"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <div className="inline-flex flex-nowrap items-center justify-end gap-0.5">
                          <button
                            type="button"
                            onClick={() => openSkill(skill)}
                            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground/80 transition hover:bg-accent hover:text-foreground"
                            aria-label={`${canEdit ? '编辑' : '查看'} ${skill.title || skill.name}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            <span className="text-[11px]">{canEdit ? '编辑' : '查看'}</span>
                          </button>
                          <button
                            type="button"
                            disabled={!canDelete}
                            onClick={() => {
                              if (!canDelete) return;
                              setPendingDelete(skill);
                            }}
                            className={cn(
                              'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 transition',
                              canDelete
                                ? 'text-muted-foreground/80 hover:bg-destructive/10 hover:text-destructive'
                                : 'cursor-not-allowed text-muted-foreground/35'
                            )}
                            aria-label={`删除 ${skill.title || skill.name}`}
                            title={canDelete ? '删除' : (skillDeleteDeniedReason(skill, skillActor(user?.id, isAdmin)) || '没有删除权限')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="text-[11px]">删除</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                    <td colSpan={6} className="px-3 py-12 text-center text-xs text-muted-foreground">
                    {skills.length ? (
                      '没有匹配的技能'
                    ) : (
                      <span className="inline-flex flex-col items-center gap-2">
                        <span>还没有技能。可以先新建一个，或上传 SKILL.md。</span>
                        <button
                          type="button"
                          onClick={() => setEditor({ mode: 'create' })}
                          className="ui-btn-primary h-8 gap-1 px-2.5 text-xs"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          新建技能
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editor ? (
        <SkillEditorDialog
          state={editor}
          canDelete={editor.skill ? skillCanDelete(editor.skill, user?.id, isAdmin) : false}
          deleteDisabledReason={editor.skill ? skillDeleteDeniedReason(editor.skill, skillActor(user?.id, isAdmin)) : null}
          currentUserId={user?.id}
          onClose={() => setEditor(null)}
          onSaved={async (text) => {
            await loadSkills();
            setMessage(text);
            setError('');
            setEditor(null);
          }}
          onDeleted={async () => {
            await loadSkills();
            setMessage('已删除');
            setError('');
            setEditor(null);
          }}
        />
      ) : null}

      {pendingDelete ? (
        <div
          className="rag-evidence-modal-backdrop"
          onClick={() => {
            if (!deleting) setPendingDelete(null);
          }}
        >
          <div
            className="rag-evidence-modal"
            role="dialog"
            aria-modal="true"
            aria-label="删除技能"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">
                删除「{pendingDelete.title || pendingDelete.name}」？
              </h3>
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                aria-label="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="ui-btn-secondary h-8 px-3 text-xs"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className={cn(
                  'inline-flex h-8 items-center rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50'
                )}
              >
                {deleting ? '正在删除…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
