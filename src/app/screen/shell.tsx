'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { AuthProvider } from '@/components/auth-provider';

export function ScreenShell({ children }: { children: ReactNode }) {
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyBg = body.style.background;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    body.style.background = '#1e2228';
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      body.style.background = prevBodyBg;
    };
  }, []);

  return <AuthProvider>{children}</AuthProvider>;
}
