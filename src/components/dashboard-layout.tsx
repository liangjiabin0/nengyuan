'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { LogOut } from 'lucide-react';
import { AppBootstrap } from '@/components/app-bootstrap';
import { AuthProvider, useAuth } from '@/components/auth-provider';
import { DashboardNav } from '@/components/dashboard-nav';
import { ImportLoadingOverlay } from '@/components/import-loading-overlay';
import { PageNavLoadingEffects, PageNavLoadingOverlay } from '@/components/page-nav-loading';
import { SidebarRoutePrefetch } from '@/components/sidebar-route-prefetch';
import { BrandMark } from '@/components/brand-mark';

const BRAND_SUBTITLE = ['A', 'I', '4', 'E', 'S'] as const;

function BrandLockup({
  markClassName,
  subtitleClassName
}: {
  markClassName: string;
  subtitleClassName: string;
}) {
  return (
    <div className="w-fit min-w-0">
      <BrandMark className={markClassName} />
      <div className={`mt-1 flex w-full justify-between ${subtitleClassName}`} aria-label="AI4ES">
        {BRAND_SUBTITLE.map((ch) => (
          <span key={ch} aria-hidden="true">
            {ch}
          </span>
        ))}
      </div>
    </div>
  );
}

type SidecarHealth = {
  healthy: boolean;
  version?: string | null;
  error?: string;
};

const SIDECAR_POLL_MS = 20_000;

function SidecarStatusDot() {
  const [health, setHealth] = useState<SidecarHealth | null>(null);
  const [checking, setChecking] = useState(true);

  const poll = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/opencode/health', { cache: 'no-store', signal });
      const data = (await response.json().catch(() => ({}))) as SidecarHealth & { error?: string };
      if (signal?.aborted) return;
      if (!response.ok) {
        setHealth({
          healthy: false,
          error: typeof data.error === 'string' ? data.error : '无法检测能元状态'
        });
        return;
      }
      setHealth({
        healthy: Boolean(data.healthy),
        version: data.version,
        error: data.error
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setHealth({ healthy: false, error: '无法检测能元状态' });
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await poll(controller.signal);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), SIDECAR_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [poll]);

  const tip = checking
    ? '正在检测能元…'
    : health?.healthy
      ? `能元：运行正常${health.version ? ` · v${health.version}` : ''}`
      : `能元：未连接${health?.error ? `（${health.error}）` : '。请运行 npm run opencode:start'}`;

  const className = checking
    ? 'rag-oc-status-dot is-checking'
    : health?.healthy
      ? 'rag-oc-status-dot'
      : 'rag-oc-status-dot is-down';

  return (
    <span
      className={`${className} mt-0.5 shrink-0`}
      title={tip}
      aria-label={tip}
      role="status"
    />
  );
}

function SidebarUser() {
  const { user, loading, localAdmin, isAdmin, logout } = useAuth();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const displayName = mounted ? user?.username || (loading ? '…' : '未登录') : '…';
  const initial = displayName.slice(0, 1).toUpperCase();
  const roleLabel = localAdmin ? '本机管理员' : isAdmin ? '管理员' : '科研用户';

  return (
    <div className="mt-auto shrink-0 border-t border-sidebar-border px-3 py-3">
      <div className="flex items-center gap-3 rounded-lg px-2 py-2">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
          suppressHydrationWarning
        >
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="truncate text-sm font-medium text-sidebar-foreground" suppressHydrationWarning>
              {displayName}
            </div>
            {mounted ? <SidecarStatusDot /> : <span className="rag-oc-status-dot is-checking mt-0.5 shrink-0" />}
          </div>
          <div className="text-xs text-muted-foreground">{mounted ? roleLabel : ' '}</div>
        </div>
        {mounted && !localAdmin ? (
          <button
            type="button"
            onClick={() => void logout()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="退出登录"
            title="退出登录"
          >
            <LogOut className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="mt-1 flex min-h-[52px] flex-col gap-0.5 px-1">
        {mounted ? (
          <>
            <Link
              href="/account/password"
              className="rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              修改密码
            </Link>
            {isAdmin ? (
              <Link
                href="/admin/users"
                className="rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                账号管理
              </Link>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppBootstrap>
        <div className="flex h-dvh max-h-dvh overflow-hidden bg-background text-foreground">
          <PageNavLoadingEffects />
          <SidebarRoutePrefetch />
          <ImportLoadingOverlay />
          <aside className="fixed inset-y-0 left-0 z-20 hidden w-[260px] flex-col border-r border-sidebar-border bg-sidebar md:flex">
            <div className="flex w-full shrink-0 items-center px-5 pb-4 pt-5">
              <BrandLockup
                markClassName="h-9 w-auto text-sidebar-foreground"
                subtitleClassName="text-sm uppercase text-muted-foreground/50"
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3">
              <DashboardNav />
              <SidebarUser />
            </div>
          </aside>

          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:pl-[260px]">
            <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-xl md:hidden">
              <BrandLockup
                markClassName="h-8 w-auto text-foreground"
                subtitleClassName="text-xs uppercase text-muted-foreground"
              />
              <Link href="/chat" className="ui-btn-primary h-8 px-3 text-xs">
                开始问答
              </Link>
            </header>
            <div className="border-b border-border px-3 py-2 md:hidden">
              <DashboardNav compact />
            </div>
            <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="relative z-0 isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {children}
              </div>
              <PageNavLoadingOverlay />
            </main>
          </div>
        </div>
      </AppBootstrap>
    </AuthProvider>
  );
}
