import type { Metadata } from 'next';
import { AppNotifyHost } from '@/components/app-notify';
import { DatavScreenHost } from '@/components/command-screen';
import { ScrollbarEdgeReveal } from '@/components/scrollbar-edge-reveal';
import './globals.css';

export const metadata: Metadata = {
  title: '能元 · AI4ES',
  description: '面向科研数据的学科知识问答与关系探索平台',
  icons: {
    icon: [{ url: '/favicon.png?v=hajimi', type: 'image/png' }]
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ScrollbarEdgeReveal />
        {children}
        <DatavScreenHost />
        <AppNotifyHost />
      </body>
    </html>
  );
}
