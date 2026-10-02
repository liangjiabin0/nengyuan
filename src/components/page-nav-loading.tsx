'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { logPageNavMark, setPageNavMarkState } from '@/lib/page-nav-log';

export { logPageNavMark } from '@/lib/page-nav-log';

type PageNavState = {
  pendingHref: string | null;
  visible: boolean;
  fading: boolean;
  contentReady: boolean;
  startedAt: number;
};

const MIN_VISIBLE_MS = 220;
const FADE_MS = 280;
/** 页面未上报就绪时的兜底，避免遮罩永久卡住 */
const CONTENT_READY_FALLBACK_MS = 12000;

let state: PageNavState = {
  pendingHref: null,
  visible: false,
  fading: false,
  contentReady: false,
  startedAt: 0
};

const listeners = new Set<() => void>();
let finishTimer: ReturnType<typeof setTimeout> | undefined;
let fadeTimer: ReturnType<typeof setTimeout> | undefined;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<PageNavState>) {
  state = { ...state, ...patch };
  emit();
}

function clearFinishTimers() {
  if (finishTimer) {
    clearTimeout(finishTimer);
    finishTimer = undefined;
  }
  if (fadeTimer) {
    clearTimeout(fadeTimer);
    fadeTimer = undefined;
  }
}

function clearFallbackTimer() {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = undefined;
  }
}

function clearAllTimers() {
  clearFinishTimers();
  clearFallbackTimer();
}

function normalizePath(href: string) {
  try {
    const url = new URL(href, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    return `${url.pathname}${url.search}` || '/';
  } catch {
    return href.split('#')[0] || '/';
  }
}

function pathMatches(current: string, target: string) {
  const a = normalizePath(current);
  const b = normalizePath(target);
  if (a === b) return true;
  const aPath = a.split('?')[0] || '/';
  const bPath = b.split('?')[0] || '/';
  return aPath === bPath;
}

function currentLocationPath() {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search}`;
}

export function startPageNav(href: string) {
  const next = normalizePath(href);
  const current = currentLocationPath();
  if (!next || pathMatches(current, next)) return;

  clearAllTimers();
  const startedAt = Date.now();
  setState({
    pendingHref: next,
    visible: true,
    fading: false,
    contentReady: false,
    startedAt
  });
  setPageNavMarkState({ pendingHref: next, startedAt });
  logPageNavMark('click');
}

export function getPendingPageHref() {
  return state.pendingHref;
}

/** 页面首屏数据库内容就绪后调用；仅在切页进行中且路由已到位时生效 */
export function markPageContentReady() {
  if (!state.visible || !state.pendingHref || state.fading || state.contentReady) return;
  if (!pathMatches(currentLocationPath(), state.pendingHref)) return;

  clearFallbackTimer();
  logPageNavMark('content-ready');
  setState({ contentReady: true });
  finishPageNav();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

const SERVER_SNAPSHOT: PageNavState = {
  pendingHref: null,
  visible: false,
  fading: false,
  contentReady: false,
  startedAt: 0
};

function getServerSnapshot(): PageNavState {
  return SERVER_SNAPSHOT;
}

function usePageNavState() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function finishPageNav() {
  if (!state.visible || state.fading || !state.contentReady) return;

  const elapsed = Date.now() - state.startedAt;
  const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);

  clearFinishTimers();
  finishTimer = setTimeout(() => {
    setState({ fading: true });
    fadeTimer = setTimeout(() => {
      clearFallbackTimer();
      setState({
        pendingHref: null,
        visible: false,
        fading: false,
        contentReady: false,
        startedAt: 0
      });
      setPageNavMarkState({ pendingHref: null, startedAt: 0 });
    }, FADE_MS);
  }, wait);
}

function isModifiedClick(event: MouseEvent) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function resolveInternalHref(anchor: HTMLAnchorElement) {
  if (anchor.target && anchor.target !== '_self') return null;
  if (anchor.hasAttribute('download')) return null;
  const raw = anchor.getAttribute('href');
  if (!raw || raw.startsWith('#')) return null;
  if (raw.startsWith('mailto:') || raw.startsWith('tel:')) return null;

  try {
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin) return null;
    return `${url.pathname}${url.search}` || '/';
  } catch {
    return null;
  }
}

/** 页面将 `ready` 置为 true 时通知切页遮罩可以淡出 */
export function usePageContentReady(ready: boolean) {
  useEffect(() => {
    logPageNavMark('mounted');
  }, []);

  useEffect(() => {
    if (ready) markPageContentReady();
  }, [ready]);
}

/** 捕获站内链接点击；路由到位后等待内容就绪再淡出 */
export function PageNavLoadingEffects() {
  const pathname = usePathname();
  const nav = usePageNavState();

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || isModifiedClick(event)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const href = resolveInternalHref(anchor);
      if (!href) return;
      startPageNav(href);
    }

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    if (!nav.pendingHref || nav.contentReady || nav.fading) return;
    if (!pathMatches(pathname, nav.pendingHref)) return;

    clearFallbackTimer();
    fallbackTimer = setTimeout(() => {
      markPageContentReady();
    }, CONTENT_READY_FALLBACK_MS);

    return () => clearFallbackTimer();
  }, [pathname, nav.pendingHref, nav.contentReady, nav.fading]);

  return null;
}

/** 主内容区呼吸点遮罩：数据就绪后淡出 */
export function PageNavLoadingOverlay() {
  const { visible, fading } = usePageNavState();
  if (!visible) return null;

  return (
    <div
      className={`page-nav-loading-overlay${fading ? ' is-fading' : ''}`}
      aria-busy="true"
      aria-live="polite"
    >
      <span className="page-nav-loading-dot" />
      <span className="sr-only">页面加载中</span>
    </div>
  );
}

/** 侧栏高亮用：优先显示即将前往的路径 */
export function useOptimisticPathname(pathname: string) {
  const { pendingHref } = usePageNavState();
  if (!pendingHref) return pathname;
  return pendingHref.split('?')[0] || pathname;
}
