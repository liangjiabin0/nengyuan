'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const WARM_HREFS = [
  '/chat',
  '/grid-guide',
  '/scheme-solve',
  '/virtual-sim',
  '/ppt-voice',
  '/graph',
  '/corpus',
  '/skills',
  '/self-learning'
] as const;

export function SidebarRoutePrefetch() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const warm = () => {
      if (cancelled) return;
      for (const href of WARM_HREFS) {
        router.prefetch(href);
      }
    };

    const idle = window.requestIdleCallback;
    let idleId = 0;
    let timeoutId = 0;
    if (typeof idle === 'function') {
      idleId = idle(warm, { timeout: 2500 });
    } else {
      timeoutId = window.setTimeout(warm, 800);
    }

    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === 'function' && idleId) {
        window.cancelIdleCallback(idleId);
      }
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [router]);

  return null;
}
