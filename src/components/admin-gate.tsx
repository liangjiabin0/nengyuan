'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { usePageContentReady } from '@/components/page-nav-loading';

export function AdminGate({ children }: { children: ReactNode }) {
  const { isAdmin, loading } = useAuth();
  const router = useRouter();
  // 无权限时子页面不会挂载，此处直接结束切页遮罩
  usePageContentReady(!loading && !isAdmin);

  useEffect(() => {
    if (!loading && !isAdmin) {
      router.replace('/');
    }
  }, [isAdmin, loading, router]);

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-slate-500">校验权限…</div>;
  }
  if (!isAdmin) {
    return <div className="flex flex-1 items-center justify-center text-sm text-slate-500">需要管理员权限</div>;
  }
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>;
}
