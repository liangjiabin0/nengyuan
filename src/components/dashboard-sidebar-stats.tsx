'use client';

import { formatNumber } from '@/lib/utils';
import { useDashboardStats } from '@/components/dashboard-stats-context';

export function DashboardSidebarStats() {
  const { data, loading } = useDashboardStats();
  const stats = data?.stats;
  const indexStats = data?.indexStats;

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/80 p-3">
      <div className="text-[11px] font-medium text-slate-400">概览</div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div><div className="text-[11px] text-slate-400">项目</div><div className="font-semibold tabular-nums text-slate-900">{loading || !stats ? '—' : formatNumber(stats.projects)}</div></div>
        <div><div className="text-[11px] text-slate-400">成果</div><div className="font-semibold tabular-nums text-slate-900">{loading || !stats ? '—' : formatNumber(stats.outputs)}</div></div>
        <div><div className="text-[11px] text-slate-400">索引</div><div className="font-semibold tabular-nums text-slate-900">{loading || !indexStats ? '—' : formatNumber(indexStats.searchRecords)}</div></div>
        <div><div className="text-[11px] text-slate-400">关系</div><div className="font-semibold tabular-nums text-slate-900">{loading || !stats ? '—' : formatNumber(stats.edges)}</div></div>
      </div>
    </div>
  );
}

export function DashboardMobileStats() {
  const { data, loading } = useDashboardStats();
  const stats = data?.stats;

  if (loading || !stats) return null;
  return (
    <div className="text-[11px] text-slate-500">
      {formatNumber(stats.projects)} 项目 · {formatNumber(stats.outputs)} 成果
    </div>
  );
}
