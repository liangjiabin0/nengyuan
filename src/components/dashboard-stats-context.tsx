'use client';

import { createContext, useContext } from 'react';
import type { DbSummaryPayload } from '@/lib/db-summary';

type DashboardStatsContextValue = {
  data: DbSummaryPayload | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const DashboardStatsContext = createContext<DashboardStatsContextValue>({
  data: null,
  loading: true,
  refresh: async () => {}
});

export function DashboardStatsProvider({
  value,
  children
}: {
  value: DashboardStatsContextValue;
  children: React.ReactNode;
}) {
  return <DashboardStatsContext.Provider value={value}>{children}</DashboardStatsContext.Provider>;
}

export function useDashboardStats() {
  return useContext(DashboardStatsContext);
}
