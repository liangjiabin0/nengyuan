'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { AuthUserPublic } from '@/lib/auth/types';

type AuthContextValue = {
  user: AuthUserPublic | null;
  loading: boolean;
  localAdmin: boolean;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  localAdmin: false,
  isAdmin: false,
  refresh: async () => undefined,
  logout: async () => undefined
});

function isLoopbackHost() {
  if (typeof window === 'undefined') return false;
  return /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i.test(window.location.hostname);
}

let redirectingToLogin = false;
const AUTH_SYNC_KEY = 'ai4es:auth-sync';

function redirectToLogin(pathname: string) {
  if (typeof window === 'undefined') return;
  if (redirectingToLogin) return;
  if (pathname === '/login' || pathname.startsWith('/login?')) return;
  const next = pathname && pathname !== '/login' ? pathname : '/';
  const target = `/login?next=${encodeURIComponent(next)}`;
  if (window.location.pathname === '/login') return;
  redirectingToLogin = true;
  window.location.replace(target);
}

function isAuthMeUrl(url: string) {
  return url.includes('/api/auth/me') || url.includes('/api/auth/login');
}

function isBackgroundPollUrl(url: string) {
  return /\/api\/(opencode\/health|system\/runtime|system\/model-context|system\/context-usage|data-import)(\?|$)/.test(url);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUserPublic | null>(null);
  const [localAdmin, setLocalAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const knownUserIdRef = useRef<string | null | undefined>(undefined);
  const refreshSeqRef = useRef(0);
  pathnameRef.current = pathname;

  const broadcastAuthChange = useCallback(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        AUTH_SYNC_KEY,
        `${Date.now()}:${Math.random().toString(36).slice(2)}`
      );
    } catch {
      // Storage may be disabled; focus/visibility refresh remains as a fallback.
    }
  }, []);

  const applyAuthState = useCallback((nextUser: AuthUserPublic | null, nextLocalAdmin: boolean) => {
    const nextUserId = nextUser?.id || null;
    const changed = knownUserIdRef.current !== nextUserId;
    knownUserIdRef.current = nextUserId;
    setUser(nextUser);
    setLocalAdmin(nextLocalAdmin);
    if (changed) broadcastAuthChange();
  }, [broadcastAuthChange]);

  const refresh = useCallback(async () => {
    const refreshSeq = ++refreshSeqRef.current;
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'include' });
      const payload = await response.json().catch(() => ({}));
      if (refreshSeq !== refreshSeqRef.current) return;
      if (payload.authenticated && payload.user) {
        applyAuthState(payload.user as AuthUserPublic, Boolean(payload.localAdmin));
      } else {
        applyAuthState(null, false);
        const currentPath = pathnameRef.current || '/';
        if (currentPath !== '/login' && !isLoopbackHost()) {
          redirectToLogin(currentPath);
        }
      }
    } catch {
      // 接口闪断时保留当前会话，避免整页跳登录
    } finally {
      if (refreshSeq === refreshSeqRef.current) setLoading(false);
    }
  }, [applyAuthState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_SYNC_KEY) void refresh();
    };
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  // 确认会话真的失效后再回登录页，避免健康检查/API 闪断把整页打去 /login。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const originalFetch = window.fetch.bind(window);

    async function confirmExpiredAndRedirect() {
      if (redirectingToLogin) return;
      if (isLoopbackHost()) return;
      try {
        const me = await originalFetch('/api/auth/me', { cache: 'no-store', credentials: 'include' });
        const payload = (await me.json().catch(() => ({}))) as { authenticated?: boolean };
        if (payload.authenticated) return;
      } catch {
        return;
      }
      redirectToLogin(pathnameRef.current || window.location.pathname || '/');
    }

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      const nextInit: RequestInit = { ...init };
      if (url.includes('/api/') && !nextInit.credentials) {
        nextInit.credentials = 'include';
      }
      const response = await originalFetch(input, nextInit);
      if (response.status !== 401) return response;
      if (!url.includes('/api/') || isAuthMeUrl(url) || isBackgroundPollUrl(url)) {
        return response;
      }

      try {
        const clone = response.clone();
        const payload = await clone.json().catch(() => null);
        const message = String(payload?.error || '');
        if (message.includes('未登录') || message.includes('会话已过期')) {
          void confirmExpiredAndRedirect();
        }
      } catch {
        // 解析失败多半是网关闪断，不整页跳转
      }
      return response;
    };
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    refreshSeqRef.current += 1;
    applyAuthState(null, false);
    if (isLoopbackHost()) {
      window.location.href = '/';
    } else {
      window.location.href = '/login';
    }
  }, [applyAuthState]);

  const value = useMemo(
    () => ({
      user,
      loading,
      localAdmin,
      isAdmin: user?.role === 'admin' || localAdmin,
      refresh,
      logout
    }),
    [user, loading, localAdmin, refresh, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
