'use client';

import { useEffect, useMemo, useState } from 'react';
import { notify } from '@/lib/notify';
import { useAuth } from '@/components/auth-provider';
import { DashboardStatsProvider } from '@/components/dashboard-stats-context';
import type { DbSummaryPayload } from '@/lib/db-summary';

type BootstrapResponse = DbSummaryPayload & { ready: boolean; source: string };

export function AppBootstrap({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DbSummaryPayload | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (authLoading) return;
      if (!user) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const response = await fetch('/api/bootstrap', { credentials: 'include', cache: 'no-store' });
        const payload = (await response.json()) as BootstrapResponse & { error?: string };
        if (!response.ok) throw new Error(payload.error || '初始化失败');
        if (!cancelled) {
          setData(payload);
        }
      } catch (err) {
        if (!cancelled) {
          const text = err instanceof Error ? err.message : '初始化失败';
          notify.warning(`概况加载异常：${text}。仍可继续使用，侧边栏数字可能暂不可用`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user?.id]);

  const providerValue = useMemo(
    () => ({
      data,
      loading: authLoading || loading,
      refresh: async () => {
        setLoading(true);
        try {
          const response = await fetch('/api/bootstrap?refresh=1', { credentials: 'include', cache: 'no-store' });
          const payload = (await response.json()) as BootstrapResponse;
          if (response.ok) {
            setData(payload);
          }
        } finally {
          setLoading(false);
        }
      }
    }),
    [authLoading, data, loading]
  );

  return (
    <DashboardStatsProvider value={providerValue}>
      {children}
    </DashboardStatsProvider>
  );
}
