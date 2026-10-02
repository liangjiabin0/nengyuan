'use client';

import { useEffect, useMemo, useState } from 'react';
import { BrainCircuit, Pin, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useNotifyError } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { UiSelect } from '@/components/ui-select';
import { cn } from '@/lib/utils';

type LearningDomain = {
  key: string;
  label: string;
};

type LearningMemory = {
  id: string;
  domainKey: string;
  domainLabel: string;
  kind: string;
  instruction: string;
  operation: string;
  applicability: string;
  active: boolean;
  pinned: boolean;
  updatedAt: string;
};

type StatusFilter = 'all' | 'active' | 'archived';

const KIND_LABELS: Record<string, string> = {
  instruction: '指令',
  preference: '偏好',
  workflow: '流程',
  correction: '纠错'
};

function formatDate(value: string) {
  if (!value) return '—';
  return value.slice(0, 16).replace('T', ' ');
}

export function SelfLearningMemoryPage() {
  const [domains, setDomains] = useState<LearningDomain[]>([]);
  const [memories, setMemories] = useState<LearningMemory[]>([]);
  const [domain, setDomain] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<LearningMemory | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pinningId, setPinningId] = useState('');
  const [, setError] = useNotifyError();

  usePageContentReady(!loading);

  async function load(background = false) {
    if (background) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/self-learning', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as {
        domains?: LearningDomain[];
        memories?: LearningMemory[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || '加载自学习记忆失败');
      setDomains(Array.isArray(payload.domains) ? payload.domains : []);
      setMemories(Array.isArray(payload.memories) ? payload.memories : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载自学习记忆失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const domainOptions = useMemo(() => {
    const byKey = new Map(domains.map((item) => [item.key, item]));
    for (const memory of memories) {
      if (!byKey.has(memory.domainKey)) {
        byKey.set(memory.domainKey, { key: memory.domainKey, label: memory.domainLabel });
      }
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }, [domains, memories]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return memories.filter((memory) => {
      if (domain && memory.domainKey !== domain) return false;
      if (status === 'active' && !memory.active) return false;
      if (status === 'archived' && memory.active) return false;
      if (!needle) return true;
      return [
        memory.domainLabel,
        memory.instruction,
        memory.applicability,
        memory.operation,
        KIND_LABELS[memory.kind] || memory.kind
      ].some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }, [domain, memories, query, status]);

  const pinnedCount = memories.filter((memory) => memory.pinned && memory.active).length;

  async function togglePin(memory: LearningMemory) {
    if (pinningId) return;
    setPinningId(memory.id);
    setError('');
    try {
      const response = await fetch('/api/self-learning', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: memory.id, pinned: !memory.pinned })
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || '更新钉住状态失败');
      setMemories((current) => current.map((item) => (
        item.id === memory.id ? { ...item, pinned: !memory.pinned } : item
      )));
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新钉住状态失败');
    } finally {
      setPinningId('');
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setError('');
    try {
      const response = await fetch(`/api/self-learning?id=${encodeURIComponent(pendingDelete.id)}`, {
        method: 'DELETE'
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || '删除记忆失败');
      setMemories((current) => current.filter((item) => item.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除记忆失败');
    } finally {
      setDeleting(false);
    }
  }

  const statusOptions = [
    { id: 'all', label: '全部' },
    { id: 'active', label: '生效中' },
    { id: 'archived', label: '已归档' }
  ] as const;

  return (
    <div className="rag-shell flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          Dashboard / Self-learning
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">自学习记忆</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          未钉住的记忆不会进入对话，需要时由能元按当前问题检索。钉住后作为始终生效偏好，最多 5 条。
        </p>
      </div>

      <div className="rag-chat-card min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索记忆"
              className="ui-input h-8 pl-8 text-xs"
            />
          </div>
          <UiSelect
            className="min-w-[10rem] sm:w-44"
            value={domain}
            placeholder="全部领域"
            aria-label="按领域筛选"
            onChange={setDomain}
            options={[
              { value: '', label: '全部领域' },
              ...domainOptions.map((item) => ({ value: item.key, label: item.label }))
            ]}
          />
          <div className="flex items-center rounded-md border border-border p-0.5" role="tablist" aria-label="记忆状态">
            {statusOptions.map((item) => {
              const active = status === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStatus(item.id)}
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
          <span className="min-w-12 text-right text-xs tabular-nums text-muted-foreground">
            {visible.length}/{memories.length}
          </span>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading || refreshing}
            className="ui-btn-secondary h-8 w-8 p-0"
            aria-label="刷新自学习记忆"
            title="刷新"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </button>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-full min-h-48 items-center justify-center text-xs text-muted-foreground">加载中…</div>
          ) : visible.length ? (
            <>
              <table className="hidden w-full table-fixed text-sm md:table">
                <colgroup>
                  <col className="w-[16rem]" />
                  <col />
                  <col className="hidden w-[12rem] lg:table-column" />
                  <col className="w-[9.25rem]" />
                  <col className="w-20" />
                </colgroup>
                <thead className="sticky top-0 z-10 border-b border-border bg-muted">
                  <tr className="text-left text-[11px] font-medium text-muted-foreground">
                    <th className="px-3 py-2 font-medium">领域</th>
                    <th className="px-3 py-2 font-medium">记忆内容</th>
                    <th className="hidden px-3 py-2 font-medium lg:table-cell">适用 / 做法</th>
                    <th className="px-3 py-2 font-medium">更新时间</th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((memory) => {
                    const extra = [memory.applicability, memory.operation].filter(Boolean).join(' · ');
                    return (
                      <tr key={memory.id} className="h-10 border-b border-border/70 last:border-b-0 hover:bg-muted/40">
                        <td className="px-3 py-1.5">
                          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
                            <span className="min-w-0 truncate text-xs font-medium text-foreground" title={memory.domainLabel}>
                              {memory.domainLabel}
                            </span>
                            <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
                              {KIND_LABELS[memory.kind] || memory.kind}
                            </span>
                            {!memory.active ? (
                              <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
                                已归档
                              </span>
                            ) : null}
                            {memory.pinned && memory.active ? (
                              <span className="shrink-0 rounded bg-accent px-1.5 py-px text-[10px] leading-4 text-foreground">
                                始终生效
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="max-w-0 truncate px-3 py-1.5 text-[13px] text-foreground" title={memory.instruction}>
                          {memory.instruction}
                        </td>
                        <td
                          className="hidden max-w-0 truncate px-3 py-1.5 text-xs text-muted-foreground lg:table-cell"
                          title={extra || undefined}
                        >
                          {extra || '—'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-muted-foreground">
                          {formatDate(memory.updatedAt)}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <div className="inline-flex items-center">
                            <button
                              type="button"
                              onClick={() => void togglePin(memory)}
                              disabled={!memory.active || pinningId === memory.id || (!memory.pinned && pinnedCount >= 5)}
                              className={cn(
                                'inline-flex h-7 w-7 items-center justify-center rounded-md transition',
                                memory.pinned
                                  ? 'text-foreground hover:bg-accent'
                                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                                'disabled:cursor-not-allowed disabled:opacity-40'
                              )}
                              aria-pressed={memory.pinned}
                              aria-label={memory.pinned ? `取消钉住 ${memory.domainLabel} 记忆` : `钉住 ${memory.domainLabel} 记忆`}
                              title={memory.active ? (memory.pinned ? '取消始终生效' : '钉为始终生效') : '已归档的记忆不能钉住'}
                            >
                              <Pin className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingDelete(memory)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                              aria-label={`删除 ${memory.domainLabel} 记忆`}
                              title="删除"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <ul className="divide-y divide-border md:hidden">
                {visible.map((memory) => (
                  <li key={memory.id} className="flex h-10 items-center gap-2 px-3">
                    <span className="max-w-[4.5rem] shrink-0 truncate text-xs font-medium text-foreground" title={memory.domainLabel}>
                      {memory.domainLabel}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
                      {KIND_LABELS[memory.kind] || memory.kind}
                    </span>
                    {!memory.active ? (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
                        已归档
                      </span>
                    ) : null}
                    {memory.pinned && memory.active ? (
                      <span className="shrink-0 rounded bg-accent px-1.5 py-px text-[10px] leading-4 text-foreground">
                        始终生效
                      </span>
                    ) : null}
                    <p className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={memory.instruction}>
                      {memory.instruction}
                    </p>
                    <span className="hidden shrink-0 text-[10px] tabular-nums text-muted-foreground sm:inline">
                      {formatDate(memory.updatedAt)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void togglePin(memory)}
                      disabled={!memory.active || pinningId === memory.id || (!memory.pinned && pinnedCount >= 5)}
                      className={cn(
                        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition',
                        memory.pinned
                          ? 'text-foreground hover:bg-accent'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        'disabled:cursor-not-allowed disabled:opacity-40'
                      )}
                      aria-pressed={memory.pinned}
                      aria-label={memory.pinned ? `取消钉住 ${memory.domainLabel} 记忆` : `钉住 ${memory.domainLabel} 记忆`}
                      title={memory.active ? (memory.pinned ? '取消始终生效' : '钉为始终生效') : '已归档的记忆不能钉住'}
                    >
                      <Pin className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(memory)}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`删除 ${memory.domainLabel} 记忆`}
                      title="删除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="flex h-full min-h-48 flex-col items-center justify-center px-4 text-center">
              <BrainCircuit className="h-8 w-8 text-muted-foreground/35" />
              <p className="mt-3 text-sm font-medium text-foreground">
                {memories.length ? '没有匹配的记忆' : '暂无自学习记忆'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {memories.length ? '调整搜索词或筛选条件后重试。' : '当前账号还没有保存可复用经验。'}
              </p>
            </div>
          )}
        </div>
      </div>

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
            aria-label="删除自学习记忆"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">删除这条自学习记忆？</h3>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{pendingDelete.instruction}</p>
              </div>
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                aria-label="关闭"
                title="关闭"
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
                className="inline-flex h-8 items-center rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
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
