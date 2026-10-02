'use client';

import { StatCard } from '@/components/stat-card';
import { useDashboardStats } from '@/components/dashboard-stats-context';

export function HomeStatCards() {
  const { data, loading } = useDashboardStats();
  const stats = data?.stats;

  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <StatCard label="导入文件" value={loading ? '—' : stats?.files ?? 0} hint="Excel / CSV 数据源" />
      <StatCard label="原始记录" value={loading ? '—' : stats?.rawRecords ?? 0} hint="保留完整 JSON 行" />
      <StatCard label="项目" value={loading ? '—' : stats?.projects ?? 0} hint="归一化项目主表" />
      <StatCard label="关系边" value={loading ? '—' : stats?.edges ?? 0} hint="用于星图和关联查询" />
    </section>
  );
}
