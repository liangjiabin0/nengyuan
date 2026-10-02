'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

type HostApi = {
  show: () => HTMLElement | null;
  hide: () => void;
  goScreen: () => void;
  goHome: () => void;
};

type PendingOpen = { navigate: boolean };

const OPEN_EVENT = 'nengyuan-datav-open';

type DatavWindow = Window & {
  __nengyuanDatav?: HostApi;
  __nengyuanDatavPending?: PendingOpen | null;
  __nengyuanDatavWantFs?: boolean;
};

function datavWindow(): DatavWindow | null {
  if (typeof window === 'undefined') return null;
  return window as DatavWindow;
}

function fullscreenElement() {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement || doc.webkitFullscreenElement || null;
}

function canUseFullscreenApi() {
  if (typeof window === 'undefined' || !window.isSecureContext) return false;
  const node = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  return Boolean(node.requestFullscreen || node.webkitRequestFullscreen);
}

async function enterFullscreen(node: HTMLElement) {
  if (!canUseFullscreenApi()) return false;
  const target = node as HTMLElement & {
    webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void> | void;
  };
  const request = target.requestFullscreen?.bind(target) || target.webkitRequestFullscreen?.bind(target);
  if (!request) return false;
  try {
    await request({ navigationUI: 'hide' } as FullscreenOptions);
  } catch {
    try {
      await request();
    } catch {
      return false;
    }
  }
  return Boolean(fullscreenElement());
}

function exitFullscreenIfAny() {
  const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> | void };
  if (!fullscreenElement()) return;
  const exit = document.exitFullscreen?.bind(document) || doc.webkitExitFullscreen?.bind(document);
  if (exit) void Promise.resolve(exit()).catch(() => undefined);
}

function applyOpen(api: HostApi, navigate: boolean) {
  const w = datavWindow();
  if (w) w.__nengyuanDatavWantFs = true;
  const root = api.show() ?? document.documentElement;
  void enterFullscreen(root);
  if (navigate) api.goScreen();
}

export function openDatavScreen(options?: { navigate?: boolean }) {
  const navigate = options?.navigate !== false;
  const w = datavWindow();
  if (!w) return;
  w.__nengyuanDatavWantFs = true;
  if (w.__nengyuanDatav) {
    applyOpen(w.__nengyuanDatav, navigate);
    return;
  }
  w.__nengyuanDatavPending = { navigate };
  w.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { navigate } }));
}

export function openDatavDemo() {
  openDatavScreen({ navigate: false });
}

export function isDatavOverlayOpen() {
  if (typeof document === 'undefined') return false;
  return Boolean(document.querySelector('.cockpit-root.is-open'));
}

export function DatavScreenHost() {
  const router = useRouter();
  const pathname = usePathname();
  const rootRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const [alive, setAlive] = useState(false);
  const [open, setOpen] = useState(false);

  const show = useCallback(() => {
    closingRef.current = false;
    setAlive(true);
    setOpen(true);
    const root = rootRef.current;
    if (root) {
      root.classList.add('is-open');
      root.removeAttribute('aria-hidden');
    }
    return root;
  }, []);

  const hide = useCallback(() => {
    const w = datavWindow();
    if (w) w.__nengyuanDatavWantFs = false;
    closingRef.current = true;
    setOpen(false);
    rootRef.current?.classList.remove('is-open');
    rootRef.current?.setAttribute('aria-hidden', 'true');
  }, []);

  const goScreen = useCallback(() => {
    if (pathname !== '/screen') router.push('/screen');
  }, [pathname, router]);

  const goHome = useCallback(() => {
    if (pathname === '/screen') router.replace('/');
  }, [pathname, router]);

  const closeScreen = useCallback(() => {
    hide();
    exitFullscreenIfAny();
    goHome();
  }, [goHome, hide]);

  useEffect(() => {
    const w = datavWindow();
    if (!w) return;
    const api: HostApi = { show, hide, goScreen, goHome };
    w.__nengyuanDatav = api;

    const onOpen = (event: Event) => {
      const navigate = (event as CustomEvent<PendingOpen>).detail?.navigate !== false;
      applyOpen(api, navigate);
    };
    w.addEventListener(OPEN_EVENT, onOpen);

    const pending = w.__nengyuanDatavPending;
    if (pending) {
      w.__nengyuanDatavPending = null;
      applyOpen(api, pending.navigate);
    }

    return () => {
      w.removeEventListener(OPEN_EVENT, onOpen);
      if (w.__nengyuanDatav === api) w.__nengyuanDatav = undefined;
    };
  }, [goHome, goScreen, hide, show]);

  useEffect(() => {
    if (pathname === '/screen') {
      closingRef.current = false;
      setAlive(true);
      setOpen(true);
      rootRef.current?.classList.add('is-open');
      return;
    }
    if (pathname === '/login') return;
    if (rootRef.current?.classList.contains('is-open')) {
      hide();
      exitFullscreenIfAny();
    }
  }, [hide, pathname]);

  useEffect(() => {
    const root = rootRef.current;
    const iframe = root?.querySelector('iframe');
    if (!root || !iframe) return;

    const onLoad = () => {
      const w = datavWindow();
      if (closingRef.current || !w?.__nengyuanDatavWantFs || fullscreenElement()) return;
      void enterFullscreen(root);
    };

    iframe.addEventListener('load', onLoad);
    return () => {
      iframe.removeEventListener('load', onLoad);
    };
  }, [alive]);

  return (
    <div
      ref={rootRef}
      className={cn('cockpit-root', alive && 'is-alive', open && 'is-open')}
      aria-hidden={open ? undefined : true}
    >
      {alive ? (
        <iframe
          className="dv-player"
          title="能元平台运行监测"
          src="/datav/index.html"
          allow="fullscreen"
        />
      ) : null}
      {open ? (
        <>
          <button type="button" className="dv-close-top" onClick={closeScreen} onPointerDown={(event) => event.stopPropagation()}>
            <X size={18} />
            关闭
          </button>
          <div className="dv-actions">
            <button type="button" onClick={closeScreen} onPointerDown={(event) => event.stopPropagation()}>
              <X size={18} />
              关闭
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
