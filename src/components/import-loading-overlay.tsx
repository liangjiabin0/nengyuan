'use client';

import { useEffect, useState } from 'react';

type ImportJobState = {
  status: 'idle' | 'running' | 'done' | 'error';
  phase: string;
  message: string;
  progress: { current: number; total: number };
};

const phaseLabels: Record<string, string> = {
  preparing: '准备中',
  converting: 'CAJ 转 PDF',
  papers: '导入论文',
  patents: '导入专利',
  books: '导入书籍',
  funds: '导入基金',
  nkrd: '导入国重项目',
  mentors: '导入导师信息',
  indexing: '重建索引',
  done: '完成',
  error: '失败'
};

export function ImportLoadingOverlay() {
  const [state, setState] = useState<ImportJobState | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch('/api/data-import?light=1');
        const data = await response.json();
        if (cancelled) return;
        setState(data.state || null);
        const status = data.state?.status;
        // 仅在导入进行中轮询；结束后停止，避免全局布局永久打 API
        if (status === 'running') {
          timer = setTimeout(poll, 1500);
        }
      } catch {
        if (!cancelled) setState(null);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!state || state.status !== 'running') return null;

  const percent = state.progress.total > 0 ? Math.min(100, Math.round((state.progress.current / state.progress.total) * 100)) : null;

  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-[100] w-[min(20rem,calc(100vw-2rem))]">
      <div className="pointer-events-auto rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-slate-200 border-t-sky-600" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">正在加载中</div>
            <div className="text-xs text-slate-500">{phaseLabels[state.phase] || '处理中'}</div>
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-xs text-slate-600">{state.message || '正在处理数据，请稍候...'}</p>
        {percent !== null ? (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[11px] text-slate-400">
              <span>进度</span>
              <span>{percent}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-sky-600 transition-all" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
