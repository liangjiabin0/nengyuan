'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  FolderKanban,
  Landmark,
  MessageSquare,
  PanelLeft,
  RefreshCw,
  ScrollText,
  Users,
  X,
  type LucideIcon
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '@/components/auth-provider';
import { useNotifyError } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { cn } from '@/lib/utils';

const DOMAIN_OPTIONS = [
  {
    value: 'papers',
    label: '论文',
    description: 'knowledge-corpus/papers',
    icon: FileText
  },
  {
    value: 'patents',
    label: '专利',
    description: 'knowledge-corpus/patents',
    icon: ScrollText
  },
  {
    value: 'books',
    label: '书籍',
    description: 'knowledge-corpus/books',
    icon: BookOpen
  },
  {
    value: 'projects',
    label: '基金项目',
    description: 'knowledge-corpus/projects',
    icon: FolderKanban
  },
  {
    value: 'national-projects',
    label: '国重项目',
    description: 'knowledge-corpus/national-projects',
    icon: Landmark
  },
  {
    value: 'people',
    label: '人物',
    description: 'knowledge-corpus/people',
    icon: Users
  }
] as const;

type DomainName = (typeof DOMAIN_OPTIONS)[number]['value'];

type CorpusFileRow = {
  name: string;
  relativePath: string;
  title: string;
  size: number;
  mtime: string;
};

type ListResponse = {
  rows?: CorpusFileRow[];
  total?: number;
  page?: number;
  pageSize?: number;
  error?: string;
};

type CorpusComment = {
  id: string;
  relativePath: string;
  recordKey: string | null;
  domain: string;
  body: string;
  userId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

type ContentResponse = {
  relativePath?: string;
  name?: string;
  title?: string;
  size?: number;
  mtime?: string;
  content?: string;
  truncated?: boolean;
  recordKey?: string;
  comments?: CorpusComment[];
  error?: string;
};

const PAGE_SIZE = 20;

function domainMeta(domain: DomainName) {
  return DOMAIN_OPTIONS.find((item) => item.value === domain)!;
}

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: string) {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return value.slice(0, 19).replace('T', ' ');
  }
  return value;
}

function formatRelativeTime(value: string) {
  if (!value) return '—';
  const naive = value.trim().replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(naive);
  const date = new Date(hasZone ? naive : `${naive}Z`);
  if (Number.isNaN(date.getTime())) return formatTime(value);
  const diff = Date.now() - date.getTime();
  if (diff < 45_000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.max(1, Math.round(diff / 86_400_000))} 天前`;
  return formatTime(value);
}

function authorInitials(name: string) {
  const text = name.trim();
  if (!text) return '?';
  if (/[\u4e00-\u9fff]/.test(text)) return text.slice(0, 1);
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
  return text.slice(0, 2).toUpperCase();
}

const AVATAR_TONES = [
  'bg-emerald-100 text-emerald-800',
  'bg-sky-100 text-sky-800',
  'bg-violet-100 text-violet-800',
  'bg-amber-100 text-amber-800',
  'bg-rose-100 text-rose-800',
  'bg-teal-100 text-teal-800'
] as const;

function avatarTone(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash + name.charCodeAt(i) * (i + 1)) % AVATAR_TONES.length;
  return AVATAR_TONES[hash];
}

function CommentAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
        size === 'sm' ? 'h-7 w-7 text-[11px]' : 'h-8 w-8 text-xs',
        avatarTone(name || '?')
      )}
      aria-hidden
    >
      {authorInitials(name)}
    </span>
  );
}

function ModalShell({
  title,
  description,
  onClose,
  children,
  wide = false,
  card = false,
  flush = false
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  card?: boolean;
  flush?: boolean;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="rag-evidence-modal-backdrop" onClick={onClose}>
      <div
        className={cn(
          'rag-evidence-modal',
          wide && 'rag-evidence-modal-wide',
          card && 'rag-evidence-modal-card'
        )}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {description ? <p className="mt-1 truncate text-sm text-muted-foreground">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className={cn(flush ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'px-5 py-4')}>
          {children}
        </div>
      </div>
    </div>
  );
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="prose-corpus text-sm leading-7 text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-[15px] font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-2.5 text-sm font-semibold first:mt-0">{children}</h3>
          ),
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          a: ({ href, children }) => (
            <a href={href} className="font-medium text-emerald-800 underline" target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded-md bg-muted px-1.5 py-0.5 text-[0.9em]">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg bg-muted/70 p-3 text-xs">{children}</pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-border px-3 py-2 text-left text-xs font-semibold text-muted-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/70 px-3 py-2 align-top">{children}</td>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CorpusCommentPanel({
  comments,
  userId,
  isAdmin,
  authorName,
  onAuthorNameChange,
  commentDraft,
  onCommentDraftChange,
  commentBusy,
  editingId,
  editDraft,
  onEditDraftChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRemove,
  onSubmit
}: {
  comments: CorpusComment[];
  userId?: string;
  isAdmin: boolean;
  authorName: string;
  onAuthorNameChange: (value: string) => void;
  commentDraft: string;
  onCommentDraftChange: (value: string) => void;
  commentBusy: boolean;
  editingId: string | null;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onStartEdit: (item: CorpusComment) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onSubmit: () => void;
}) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const composerExpanded = composerOpen || Boolean(commentDraft.trim());
  const feed = useMemo(() => [...comments].reverse(), [comments]);

  useEffect(() => {
    if (!commentDraft.trim() && !commentBusy) setComposerOpen(false);
  }, [commentBusy, commentDraft]);

  return (
    <aside className="flex min-h-[18rem] min-w-0 flex-1 flex-col border-t border-border bg-muted/40 md:min-h-0 md:w-[22rem] md:flex-none md:border-l md:border-t-0">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold text-foreground">评论</h4>
        </div>
        <span className="text-xs text-muted-foreground">
          {comments.length ? `${comments.length} 条` : '暂无'}
        </span>
      </div>

      <div className="shrink-0 border-b border-border/70 px-4 py-3">
        <form
          className="flex gap-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <CommentAvatar name={authorName} />
          <div className="min-w-0 flex-1">
            {composerExpanded ? (
              <label className="mb-2 block text-[11px] font-medium text-muted-foreground">
                署名
                <input
                  className="mt-1 h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
                  value={authorName}
                  onChange={(event) => onAuthorNameChange(event.target.value)}
                  placeholder="显示名称"
                />
              </label>
            ) : null}
            <textarea
              className={cn(
                'w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none transition focus:border-ring',
                composerExpanded ? 'min-h-[5.5rem]' : 'h-9 overflow-hidden py-1.5'
              )}
              value={commentDraft}
              onChange={(event) => onCommentDraftChange(event.target.value)}
              onFocus={() => setComposerOpen(true)}
              onBlur={() => {
                if (!commentDraft.trim()) setComposerOpen(false);
              }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              placeholder="写一条评论…"
              rows={composerExpanded ? 4 : 1}
            />
            {composerExpanded ? (
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground">Ctrl + Enter 发送</p>
                <button
                  type="submit"
                  className="ui-btn-primary h-8 px-3 text-xs"
                  disabled={commentBusy || !commentDraft.trim() || !authorName.trim()}
                >
                  {commentBusy ? '发送中…' : '保存'}
                </button>
              </div>
            ) : null}
          </div>
        </form>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {feed.length ? (
          <ol className="space-y-4">
            {feed.map((item) => {
              const canEdit = item.userId === userId || isAdmin;
              const editing = editingId === item.id;
              const confirming = confirmDeleteId === item.id;
              return (
                <li key={item.id} className="flex gap-2.5">
                  <CommentAvatar name={item.authorName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-foreground">{item.authorName}</span>
                      <time
                        className="text-[11px] text-muted-foreground"
                        dateTime={item.updatedAt || item.createdAt}
                        title={formatTime(item.updatedAt || item.createdAt)}
                      >
                        {formatRelativeTime(item.updatedAt || item.createdAt)}
                        {item.updatedAt && item.updatedAt !== item.createdAt ? ' · 已编辑' : ''}
                      </time>
                    </div>
                    {editing ? (
                      <div className="mt-1.5 space-y-2">
                        <textarea
                          className="min-h-[4.5rem] w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm"
                          value={editDraft}
                          onChange={(event) => onEditDraftChange(event.target.value)}
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="ui-btn-primary h-7 px-2.5 text-xs"
                            disabled={commentBusy || !editDraft.trim()}
                            onClick={() => onSaveEdit(item.id)}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="ui-btn-ghost h-7 px-2 text-xs"
                            onClick={onCancelEdit}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="mt-1 rounded-lg border border-border/80 bg-card px-3 py-2 text-sm leading-6 text-foreground shadow-sm">
                          <p className="whitespace-pre-wrap">{item.body}</p>
                        </div>
                        {canEdit ? (
                          <div className="mt-1 flex items-center gap-2 text-[11px]">
                            {confirming ? (
                              <>
                                <span className="text-muted-foreground">删除这条评论？</span>
                                <button
                                  type="button"
                                  className="font-medium text-rose-600 hover:underline disabled:opacity-50"
                                  disabled={commentBusy}
                                  onClick={() => {
                                    setConfirmDeleteId(null);
                                    onRemove(item.id);
                                  }}
                                >
                                  确认
                                </button>
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:underline"
                                  onClick={() => setConfirmDeleteId(null)}
                                >
                                  取消
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
                                  disabled={commentBusy}
                                  onClick={() => onStartEdit(item)}
                                >
                                  编辑
                                </button>
                                <span className="text-border">·</span>
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-rose-600 hover:underline disabled:opacity-50"
                                  disabled={commentBusy}
                                  onClick={() => setConfirmDeleteId(item.id)}
                                >
                                  删除
                                </button>
                              </>
                            )}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="px-1 py-6 text-center text-sm leading-6 text-muted-foreground">
            还没有评论。写一条备注，打开同一份材料的人都能看到。
          </p>
        )}
      </div>
    </aside>
  );
}

export function CorpusBrowser() {
  const { user, isAdmin } = useAuth();
  const [domain, setDomain] = useState<DomainName>('papers');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rows, setRows] = useState<CorpusFileRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useNotifyError();
  const [reloadToken, setReloadToken] = useState(0);

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewContent, setPreviewContent] = useState('');
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [, setPreviewError] = useNotifyError();
  const [comments, setComments] = useState<CorpusComment[]>([]);
  const [authorName, setAuthorName] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [commentBusy, setCommentBusy] = useState(false);
  const [, setCommentError] = useNotifyError();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  useEffect(() => {
    if (!authorName && user?.username) setAuthorName(user.username);
  }, [authorName, user?.username]);

  const meta = domainMeta(domain);
  const DomainIcon = meta.icon as LucideIcon;

  usePageContentReady(!loading || rows.length > 0 || Boolean(error));

  useEffect(() => {
    setPage(1);
  }, [domain]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        domain,
        page: String(page),
        pageSize: String(PAGE_SIZE)
      });
      const response = await fetch(`/api/corpus?${params.toString()}`, { credentials: 'include' });
      const data = (await response.json()) as ListResponse;
      if (!response.ok) throw new Error(data.error || '加载语料文件失败');
      setRows(data.rows || []);
      setTotal(data.total || 0);
    } catch (err) {
      setRows([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : '加载语料文件失败');
    } finally {
      setLoading(false);
    }
  }, [domain, page, reloadToken]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const rangeLabel = useMemo(() => {
    if (!total) return '暂无文件';
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, total);
    return `第 ${start}–${end} 条，共 ${total} 条`;
  }, [page, total]);

  function selectDomain(next: DomainName) {
    if (next === domain) {
      setSidebarOpen(false);
      return;
    }
    setDomain(next);
    setSidebarOpen(false);
  }

  async function openPreview(row: CorpusFileRow) {
    setPreviewPath(row.relativePath);
    setPreviewTitle(row.title || row.name);
    setPreviewContent('');
    setPreviewTruncated(false);
    setPreviewError('');
    setComments([]);
    setCommentDraft('');
    setCommentError('');
    setEditingId(null);
    setPreviewLoading(true);
    try {
      const params = new URLSearchParams({ path: row.relativePath });
      const response = await fetch(`/api/corpus/content?${params.toString()}`);
      const data = (await response.json()) as ContentResponse;
      if (!response.ok) throw new Error(data.error || '读取文件失败');
      setPreviewTitle(data.title || row.title || row.name);
      setPreviewContent(data.content || '');
      setPreviewTruncated(Boolean(data.truncated));
      setComments(data.comments || []);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : '读取文件失败');
    } finally {
      setPreviewLoading(false);
    }
  }

  async function submitComment() {
    if (!previewPath || commentBusy) return;
    setCommentBusy(true);
    setCommentError('');
    try {
      const response = await fetch('/api/corpus/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          path: previewPath,
          body: commentDraft,
          authorName
        })
      });
      const data = (await response.json()) as { comments?: CorpusComment[]; error?: string };
      if (!response.ok) throw new Error(data.error || '发表备注失败');
      setComments(data.comments || []);
      setCommentDraft('');
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : '发表备注失败');
    } finally {
      setCommentBusy(false);
    }
  }

  async function saveEditedComment(id: string) {
    if (commentBusy) return;
    setCommentBusy(true);
    setCommentError('');
    try {
      const response = await fetch(`/api/corpus/comments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ body: editDraft })
      });
      const data = (await response.json()) as { comments?: CorpusComment[]; error?: string };
      if (!response.ok) throw new Error(data.error || '修改备注失败');
      setComments(data.comments || []);
      setEditingId(null);
      setEditDraft('');
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : '修改备注失败');
    } finally {
      setCommentBusy(false);
    }
  }

  async function removeComment(id: string) {
    if (commentBusy) return;
    setCommentBusy(true);
    setCommentError('');
    try {
      const response = await fetch(`/api/corpus/comments/${id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      const data = (await response.json()) as { comments?: CorpusComment[]; error?: string };
      if (!response.ok) throw new Error(data.error || '删除备注失败');
      setComments(data.comments || []);
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : '删除备注失败');
    } finally {
      setCommentBusy(false);
    }
  }

  return (
    <div className="rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Dashboard / Database
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">数据库</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          用于浏览系统知识库中的各类科研资料及其解析内容。
        </p>
      </div>

      <div className="rag-chat-card min-h-0 flex-1">
        <aside className={`rag-conv-list ${sidebarOpen ? 'flex' : 'hidden md:flex'}`}>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
            <div className="space-y-0.5">
              {DOMAIN_OPTIONS.map((item) => {
                const active = item.value === domain;
                const Icon = item.icon;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => selectDomain(item.value)}
                    className={cn('rag-conv-item w-full', active && 'rag-conv-item-active')}
                  >
                    <span
                      className={cn(
                        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                        active ? 'bg-background text-foreground shadow-sm' : 'bg-muted text-muted-foreground'
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium leading-5 text-foreground">
                        {item.label}
                      </span>
                      <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <main className={`min-h-0 min-w-0 flex-1 flex-col ${sidebarOpen ? 'hidden md:flex' : 'flex'}`}>
          <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent md:hidden"
              aria-label="打开语料分域列表"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <DomainIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{meta.label}</div>
              <div className="truncate text-xs text-muted-foreground">
                {loading ? '正在加载文件…' : `${rangeLabel} · ${meta.description}`}
              </div>
            </div>
            <button
              type="button"
              className="ui-btn-secondary h-8 gap-1.5 px-2.5"
              onClick={() => setReloadToken((value) => value + 1)}
              disabled={loading}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </button>
          </header>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
                <tr>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    标题
                  </th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    文件名
                  </th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    大小
                  </th>
                  <th className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    修改时间
                  </th>
                  <th className="whitespace-nowrap px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70 bg-card">
                {loading ? (
                  <tr>
                    <td className="px-4 py-10 text-center text-muted-foreground" colSpan={5}>
                      加载中…
                    </td>
                  </tr>
                ) : rows.length ? (
                  rows.map((row) => (
                    <tr key={row.relativePath} className="transition hover:bg-accent/60">
                      <td className="max-w-[18rem] truncate px-4 py-3" title={row.title}>
                        <button
                          type="button"
                          className="max-w-full truncate text-left font-medium text-foreground underline-offset-2 hover:underline"
                          onClick={() => void openPreview(row)}
                        >
                          {row.title || '—'}
                        </button>
                      </td>
                      <td className="max-w-[12rem] truncate px-4 py-3 text-muted-foreground" title={row.name}>
                        {row.name}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {formatBytes(row.size)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                        {formatTime(row.mtime)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end">
                          <button
                            type="button"
                            className="ui-btn-ghost h-8 gap-1 px-2 text-xs"
                            onClick={() => void openPreview(row)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            预览
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-16 text-center" colSpan={5}>
                      <div className="mx-auto flex max-w-xs flex-col items-center">
                        <DomainIcon className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />
                        <p className="mt-3 text-sm font-medium text-foreground">暂无文件</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          该分域下还没有解析后的 Markdown
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <footer className="flex shrink-0 flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">{rangeLabel}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="ui-btn-secondary h-8 gap-1 px-2.5"
                disabled={loading || page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
                上一页
              </button>
              <span className="min-w-[4.5rem] text-center text-sm text-muted-foreground">
                {page} / {pageCount}
              </span>
              <button
                type="button"
                className="ui-btn-secondary h-8 gap-1 px-2.5"
                disabled={loading || page >= pageCount}
                onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
              >
                下一页
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </footer>
        </main>
      </div>

      {previewPath ? (
        <ModalShell
          title={previewTitle || '文件预览'}
          description={previewPath}
          onClose={() => setPreviewPath(null)}
          card
          flush
        >
          {previewLoading ? (
            <p className="px-5 py-16 text-center text-sm text-muted-foreground">正在加载 Markdown…</p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
              <section className="flex min-h-0 min-w-0 flex-1 flex-col max-h-[46vh] md:max-h-none">
                <div className="flex shrink-0 items-center gap-2 px-5 pt-4">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <h4 className="text-sm font-semibold text-foreground">正文</h4>
                </div>
                {previewTruncated ? (
                  <div className="mx-5 mt-3 shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    文件较大，仅预览前部内容。
                  </div>
                ) : null}
                <div className="scrollbar-thin min-h-0 flex-1 overflow-auto px-5 py-4">
                  {previewContent ? (
                    <MarkdownPreview content={previewContent} />
                  ) : (
                    <p className="text-sm text-muted-foreground">文件内容为空。</p>
                  )}
                </div>
              </section>
              <CorpusCommentPanel
                key={previewPath}
                comments={comments}
                userId={user?.id}
                isAdmin={isAdmin}
                authorName={authorName}
                onAuthorNameChange={setAuthorName}
                commentDraft={commentDraft}
                onCommentDraftChange={setCommentDraft}
                commentBusy={commentBusy}
                editingId={editingId}
                editDraft={editDraft}
                onEditDraftChange={setEditDraft}
                onStartEdit={(item) => {
                  setEditingId(item.id);
                  setEditDraft(item.body);
                }}
                onCancelEdit={() => {
                  setEditingId(null);
                  setEditDraft('');
                }}
                onSaveEdit={(id) => void saveEditedComment(id)}
                onRemove={(id) => void removeComment(id)}
                onSubmit={() => void submitComment()}
              />
            </div>
          )}
        </ModalShell>
      ) : null}
    </div>
  );
}
