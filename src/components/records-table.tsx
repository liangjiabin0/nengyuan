'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Eye,
  FileStack,
  FileText,
  FolderKanban,
  GitBranch,
  PanelLeft,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  X
} from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { useNotifyError, useNotifySuccess } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { cn } from '@/lib/utils';

const TABLE_OPTIONS = [
  {
    value: 'projects',
    label: '科研项目',
    description: '项目名称、机构与负责人',
    icon: FolderKanban
  },
  {
    value: 'outputs',
    label: '成果产出',
    description: '论文、专利与发表信息',
    icon: FileText
  },
  {
    value: 'entities',
    label: '实体',
    description: '人物、机构与主题节点',
    icon: Tags
  },
  {
    value: 'edges',
    label: '关系边',
    description: '实体间关联与权重',
    icon: GitBranch
  },
  {
    value: 'raw_records',
    label: '原始记录',
    description: '导入行级原始数据',
    icon: Database
  },
  {
    value: 'source_files',
    label: '来源文件',
    description: '已导入的数据文件',
    icon: FileStack
  }
] as const;

type TableName = (typeof TABLE_OPTIONS)[number]['value'];

const COLUMN_LABELS: Record<string, string> = {
  id: 'ID',
  project_key: '项目键',
  project_name: '项目名称',
  institution: '机构',
  principal_investigator: '负责人',
  year: '年份',
  keywords: '关键词',
  updated_at: '更新时间',
  output_key: '成果键',
  title: '标题',
  publication: '发表刊物',
  authors: '作者',
  entity_key: '实体键',
  type: '类型',
  name: '名称',
  meta: '元数据',
  edge_key: '关系键',
  source_key: '源节点',
  target_key: '目标节点',
  relation: '关系',
  weight: '权重',
  filename: '文件名',
  sheet_name: '工作表',
  row_count: '行数',
  imported_at: '导入时间',
  status: '状态',
  source_file_id: '来源文件',
  row_index: '行号',
  payload: '原始数据',
  created_at: '创建时间'
};

const PRIMARY_COLUMNS: Record<TableName, string> = {
  projects: 'project_name',
  outputs: 'title',
  entities: 'name',
  edges: 'relation',
  raw_records: 'project_key',
  source_files: 'filename'
};

const PAGE_SIZE = 20;

type RecordsResponse = {
  rows?: Record<string, unknown>[];
  total?: number;
  page?: number;
  pageSize?: number;
  displayColumns?: string[];
  primaryKey?: string;
  error?: string;
};

function columnLabel(column: string) {
  return COLUMN_LABELS[column] || column;
}

function getTableMeta(table: TableName) {
  return TABLE_OPTIONS.find((item) => item.value === table)!;
}

function formatCell(value: unknown) {
  if (value == null || value === '') return '—';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    return text.slice(0, 19).replace('T', ' ');
  }
  return text;
}

function ModalShell({
  title,
  description,
  onClose,
  children,
  dismissible = true
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  dismissible?: boolean;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && dismissible) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismissible, onClose]);

  return (
    <div
      className="rag-evidence-modal-backdrop"
      onClick={() => {
        if (dismissible) onClose();
      }}
    >
      <div
        className="rag-evidence-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!dismissible}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">
          {children}
        </div>
      </div>
    </div>
  );
}

export function RecordsTable() {
  const { isAdmin } = useAuth();
  const [table, setTable] = useState<TableName>('projects');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [primaryKey, setPrimaryKey] = useState('id');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useNotifyError();
  const [, setMessage] = useNotifySuccess();
  const [busy, setBusy] = useState(false);
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);
  const [deleteRow, setDeleteRow] = useState<Record<string, unknown> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const tableMeta = getTableMeta(table);
  const TableIcon = tableMeta.icon;

  usePageContentReady(!loading || rows.length > 0 || Boolean(error));

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setPage(1);
  }, [table, debouncedQuery]);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        table,
        page: String(page),
        pageSize: String(PAGE_SIZE)
      });
      if (debouncedQuery) params.set('q', debouncedQuery);

      const response = await fetch(`/api/records?${params.toString()}`, { credentials: 'include' });
      const data = (await response.json()) as RecordsResponse;
      if (!response.ok) throw new Error(data.error || '加载数据失败');

      setRows(data.rows || []);
      setTotal(data.total || 0);
      setColumns(
        data.displayColumns?.length
          ? data.displayColumns
          : Object.keys(data.rows?.[0] || {}).slice(0, 12)
      );
      setPrimaryKey(data.primaryKey || 'id');
    } catch (err) {
      setRows([]);
      setTotal(0);
      setColumns([]);
      setError(err instanceof Error ? err.message : '加载数据失败');
    } finally {
      setLoading(false);
    }
  }, [table, page, debouncedQuery, reloadToken]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const primaryColumn = PRIMARY_COLUMNS[table];
  const colSpan = Math.max(columns.length, 1) + 1;

  const rangeLabel = useMemo(() => {
    if (!total) return '暂无记录';
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(page * PAGE_SIZE, total);
    return `第 ${start}–${end} 条，共 ${total} 条`;
  }, [page, total]);

  function clearFeedback() {
    setError('');
    setMessage('');
  }

  function selectTable(next: TableName) {
    if (next === table) {
      setSidebarOpen(false);
      return;
    }
    clearFeedback();
    setTable(next);
    setQuery('');
    setDebouncedQuery('');
    setSidebarOpen(false);
  }

  function refresh() {
    clearFeedback();
    setReloadToken((value) => value + 1);
  }

  async function confirmDelete() {
    if (!deleteRow || !isAdmin) return;
    const id = deleteRow[primaryKey];
    if (id == null) {
      setError('缺少主键，无法删除');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/records', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table, id })
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error || '删除失败');
      setMessage('已删除记录');
      setDeleteRow(null);
      if (rows.length === 1 && page > 1) {
        setPage((value) => value - 1);
      } else {
        setReloadToken((value) => value + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Dashboard / Tables
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">科研数据表</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          用于查看和检索系统中的结构化科研数据。
        </p>
      </div>

      <div className="rag-chat-card min-h-0 flex-1">
        <aside className={`rag-conv-list ${sidebarOpen ? 'flex' : 'hidden md:flex'}`}>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
            <div className="space-y-0.5">
              {TABLE_OPTIONS.map((item) => {
                const active = item.value === table;
                const Icon = item.icon;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => selectTable(item.value)}
                    className={cn(
                      'rag-conv-item w-full',
                      active && 'rag-conv-item-active'
                    )}
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
              aria-label="打开数据表列表"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <TableIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{tableMeta.label}</div>
              <div className="truncate text-xs text-muted-foreground">
                {loading ? '正在加载记录…' : `${rangeLabel} · ${tableMeta.description}`}
              </div>
            </div>
            <button
              type="button"
              className="ui-btn-secondary h-8 gap-1.5 px-2.5"
              onClick={refresh}
              disabled={loading}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </button>
          </header>

          <div className="flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                className="ui-input h-9 pl-9"
                placeholder={`搜索${tableMeta.label}…`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground sm:text-right">
              每页 {PAGE_SIZE} 条 · 支持字段模糊检索
            </p>
          </div>

          <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur">
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column}
                      className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                    >
                      {columnLabel(column)}
                    </th>
                  ))}
                  <th className="whitespace-nowrap px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70 bg-card">
                {loading ? (
                  <tr>
                    <td className="px-4 py-10 text-center text-muted-foreground" colSpan={colSpan}>
                      加载中…
                    </td>
                  </tr>
                ) : rows.length ? (
                  rows.map((row, index) => {
                    const rowKey = String(row[primaryKey] ?? index);
                    return (
                      <tr key={rowKey} className="transition hover:bg-accent/60">
                        {columns.map((column) => {
                          const display = formatCell(row[column]);
                          const isPrimary = column === primaryColumn;
                          return (
                            <td
                              key={column}
                              className={cn(
                                'max-w-[16rem] truncate px-4 py-3',
                                isPrimary ? 'font-medium text-foreground' : 'text-muted-foreground'
                              )}
                              title={display === '—' ? undefined : display}
                            >
                              {display}
                            </td>
                          );
                        })}
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              className="ui-btn-ghost h-8 gap-1 px-2 text-xs"
                              onClick={() => {
                                clearFeedback();
                                setDetailRow(row);
                              }}
                            >
                              <Eye className="h-3.5 w-3.5" />
                              详情
                            </button>
                            {isAdmin ? (
                              <button
                                type="button"
                                className="ui-btn-ghost h-8 gap-1 px-2 text-xs text-rose-600 hover:text-rose-700"
                                onClick={() => {
                                  clearFeedback();
                                  setDeleteRow(row);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                删除
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td className="px-4 py-16 text-center" colSpan={colSpan}>
                      <div className="mx-auto flex max-w-xs flex-col items-center">
                        <TableIcon className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.4} />
                        <p className="mt-3 text-sm font-medium text-foreground">
                          {debouncedQuery ? '没有匹配的记录' : '暂无数据'}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {debouncedQuery
                            ? '请调整搜索关键词后再试'
                            : '请先在数据资源管理中导入文件'}
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

      {detailRow ? (
        <ModalShell
          title="记录详情"
          description={`${tableMeta.label} · ${formatCell(detailRow[primaryKey])}`}
          onClose={() => setDetailRow(null)}
        >
          <dl className="scrollbar-thin max-h-[min(60vh,28rem)] space-y-3 overflow-auto pr-1">
            {Object.entries(detailRow).map(([key, value]) => (
              <div
                key={key}
                className="grid gap-1 border-b border-border pb-3 last:border-0 last:pb-0 sm:grid-cols-[8rem_1fr]"
              >
                <dt className="text-xs font-medium text-muted-foreground">{columnLabel(key)}</dt>
                <dd className="break-all whitespace-pre-wrap text-sm text-foreground">
                  {formatCell(value)}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 flex justify-end">
            <button type="button" className="ui-btn-secondary" onClick={() => setDetailRow(null)}>
              关闭
            </button>
          </div>
        </ModalShell>
      ) : null}

      {deleteRow ? (
        <ModalShell
          title="删除记录"
          description="删除后将同步重建检索索引，此操作不可撤销。"
          onClose={() => {
            if (!busy) setDeleteRow(null);
          }}
          dismissible={!busy}
        >
          <p className="text-sm text-muted-foreground">
            确认删除 {tableMeta.label} 中主键为{' '}
            <span className="font-medium text-foreground">{formatCell(deleteRow[primaryKey])}</span>{' '}
            的记录？
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="ui-btn-ghost"
              disabled={busy}
              onClick={() => setDeleteRow(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="ui-btn-primary bg-rose-600 hover:bg-rose-700"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              {busy ? '删除中…' : '确认删除'}
            </button>
          </div>
        </ModalShell>
      ) : null}
    </div>
  );
}
