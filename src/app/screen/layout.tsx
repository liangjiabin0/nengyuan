import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ScreenShell } from './shell';

export const metadata: Metadata = {
  title: '运行监测 · 能元'
};

export default function ScreenLayout({ children }: { children: ReactNode }) {
  return <ScreenShell>{children}</ScreenShell>;
}
