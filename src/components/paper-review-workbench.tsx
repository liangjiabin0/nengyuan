'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileSearch, Plus, Trash2 } from 'lucide-react';
import { useNotifyError } from '@/components/app-notify';
import { usePageContentReady } from '@/components/page-nav-loading';
import { PaperReviewNewTask } from '@/components/paper-review-new-task';
import { PaperReviewTaskView, type EventView, type TaskDetail } from '@/components/paper-review-task-view';
import { cn } from '@/lib/utils';

type TaskSummary = { id: string; title: string; status: string; stage: string; progress: number; updatedAt: string };

const STATUS_DOT: Record<string, string> = {
  completed: 'bg-emerald-500', running: 'bg-sky-500 animate-pulse', queued: 'bg-sky-400', partial: 'bg-amber-500', blocked: 'bg-amber-600', failed: 'bg-rose-500', cancelled: 'bg-muted-foreground', draft: 'bg-muted-foreground/50'
};

/** 论文智能评审工作台：左侧任务列表，右侧新建或任务详情。刷新页面后自动恢复进度显示。 */
export function PaperReviewWorkbench() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modelLabel, setModelLabel] = useState('未配置');
  const lastEvent = useRef(0);
  const [, setError] = useNotifyError();

  usePageContentReady(!loading);

  const loadList = useCallback(async () => {
    const res = await fetch('/api/paper-review', { cache: 'no-store' });
    const data = (await res.json().catch(() => ({}))) as { tasks?: TaskSummary[]; error?: string };
    if (!res.ok) throw new Error(data.error || '读取任务列表失败');
    setTasks(data.tasks || []);
  }, []);

  const loadDetail = useCallback(async (id: string, reset = false) => {
    if (reset) lastEvent.current = 0;
    const res = await fetch(`/api/paper-review/${id}?after=${lastEvent.current}`, { cache: 'no-store' });
    const data = (await res.json().catch(() => ({}))) as { task?: TaskDetail; events?: EventView[]; error?: string };
    if (!res.ok || !data.task) throw new Error(data.error || '读取任务失败');
    setDetail(data.task);
    const incoming = data.events || [];
    if (incoming.length) lastEvent.current = incoming[incoming.length - 1].id;
    setEvents((cur) => (reset ? incoming : [...cur, ...incoming]));
    return data.task;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await loadList();
        const res = await fetch('/api/paper-review/model', { cache: 'no-store' });
        const d = (await res.json().catch(() => ({}))) as { config?: { model: string; baseUrl: string; thinking: string } };
        if (d.config) setModelLabel(`${d.config.model}（思考 ${d.config.thinking}）@ ${d.config.baseUrl ? new URL(d.config.baseUrl).host : '未配置地址'}`);
        const fromUrl = new URLSearchParams(window.location.search).get('task');
        if (fromUrl) setSelectedId(fromUrl);
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadList, setError]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); setEvents([]); return; }
    const url = new URL(window.location.href);
    url.searchParams.set('task', selectedId);
    window.history.replaceState(null, '', url.toString());
    void loadDetail(selectedId, true).catch((e) => setError(e.message));
  }, [selectedId, loadDetail, setError]);

  // 运行中每 2 秒轮询一次（刷新页面后同样从服务器恢复状态）
  const running = Boolean(detail?.running);
  useEffect(() => {
    if (!selectedId || !running) return;
    const timer = setInterval(() => {
      void loadDetail(selectedId).then((t) => { if (!t.running) void loadList(); }).catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [selectedId, running, loadDetail, loadList]);

  async function action(name: string, extra: Record<string, unknown> = {}) {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/paper-review/${selectedId}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, ...extra }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || '操作失败');
      await loadDetail(selectedId);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm('删除该评审任务及其全部文件？此操作不可恢复。')) return;
    const res = await fetch(`/api/paper-review/${id}`, { method: 'DELETE' });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) { setError(data.error || '删除失败'); return; }
    if (selectedId === id) setSelectedId(null);
    await loadList();
  }

  return (
    <div className="rag-shell flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4">
      <div className="mb-3 shrink-0">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">Dashboard / Paper review</div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">论文智能评审</h1>
        <p className="mt-1 text-sm text-muted-foreground">上传论文 → 证据核对 → 真实运行原理级复现 → 按 v8 出具评审报告 → 按 v3 生成两页可编辑 PPT → 质量门禁 → 打包下载。</p>
      </div>
      <div className="rag-chat-card min-h-0 flex-1 flex-row overflow-hidden">
        <aside className="flex w-56 shrink-0 flex-col border-r border-border max-md:hidden">
          <div className="border-b border-border p-2">
            <button type="button" className="ui-btn-primary h-8 w-full gap-1 text-xs" onClick={() => setSelectedId(null)}>
              <Plus className="h-3.5 w-3.5" />新建评审
            </button>
          </div>
          <ul className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1">
            {tasks.map((t) => (
              <li key={t.id} className="group">
                <div className={cn('flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs', selectedId === t.id ? 'bg-accent' : 'hover:bg-accent/60')}>
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[t.status] || 'bg-muted-foreground')} />
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-foreground" title={t.title} onClick={() => setSelectedId(t.id)}>{t.title || '未命名'}</button>
                  <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">{t.progress}%</span>
                  <button type="button" className="shrink-0 text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100" aria-label={`删除 ${t.title}`} onClick={() => void remove(t.id)}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </li>
            ))}
            {!tasks.length && !loading ? <li className="px-2 py-4 text-center text-xs text-muted-foreground">还没有评审任务</li> : null}
          </ul>
        </aside>
        <main className="min-h-0 min-w-0 flex-1">
          <div className="border-b border-border p-2 md:hidden">
            <select className="ui-input h-8 w-full text-xs" value={selectedId || ''} onChange={(e) => setSelectedId(e.target.value || null)} aria-label="选择评审任务">
              <option value="">＋ 新建评审</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.title} · {t.progress}%</option>)}
            </select>
          </div>
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">加载中…</div>
          ) : selectedId && detail ? (
            <PaperReviewTaskView task={detail} events={events} onAction={action} busy={busy} />
          ) : selectedId ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><FileSearch className="mr-1 h-4 w-4" />读取任务…</div>
          ) : (
            <PaperReviewNewTask modelLabel={modelLabel} onCreated={(id) => { void loadList(); setSelectedId(id); }} />
          )}
        </main>
      </div>
    </div>
  );
}
