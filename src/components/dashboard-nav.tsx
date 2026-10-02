'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  AudioLines,
  BrainCircuit,
  BookOpen,
  CircuitBoard,
  Files,
  Home,
  Lightbulb,
  MessageSquareText,
  Network,
  Settings,
  Sparkles,
  Table2,
  Users,
  type LucideIcon
} from 'lucide-react';
import { useAuth } from '@/components/auth-provider';
import { useOptimisticPathname } from '@/components/page-nav-loading';
import { cn } from '@/lib/utils';

type NavItem = { href: string; label: string; icon: LucideIcon; adminOnly?: boolean };

const primaryNav: NavItem[] = [
  { href: '/', label: '首页', icon: Home },
  { href: '/chat', label: '能元Agent', icon: MessageSquareText },
  { href: '/grid-guide', label: '国网指南设计', icon: BookOpen },
  { href: '/scheme-solve', label: '方案求解', icon: Lightbulb },
  { href: '/virtual-sim', label: '虚拟仿真', icon: CircuitBoard },
  { href: '/ppt-voice', label: 'PPT 智能配音', icon: AudioLines }
];

const researchNav: NavItem[] = [
  { href: '/graph', label: '学科研究图谱', icon: Network },
  { href: '/corpus', label: '数据库', icon: Files },
  { href: '/skills', label: '技能库', icon: Sparkles },
  { href: '/self-learning', label: '自学习记忆', icon: BrainCircuit }
];

const adminNav: NavItem[] = [
  { href: '/tables', label: '科研数据表', icon: Table2, adminOnly: true },
  { href: '/settings', label: '系统设置', icon: Settings, adminOnly: true },
  { href: '/admin/users', label: '账号管理', icon: Users, adminOnly: true }
];

function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const activePath = useOptimisticPathname(pathname);
  const { isAdmin } = useAuth();
  const [mounted, setMounted] = useState(false);
  const visibleAdmin = isAdmin ? adminNav : [];
  const allItems = [...primaryNav, ...researchNav, ...visibleAdmin];

  useEffect(() => setMounted(true), []);

  if (compact) {
    return (
      <nav className="flex gap-1.5 overflow-x-auto pb-0.5">
        {allItems.map((item) => {
          const active = mounted && isActive(activePath, item.href);
          const className = cn(
            'shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition',
            active
              ? 'bg-primary text-primary-foreground'
              : 'border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground'
          );
          return (
            <Link key={item.href} href={item.href} className={className}>
              {item.label}
            </Link>
          );
        })}
      </nav>
    );
  }

  const renderItem = (item: NavItem) => {
    const active = mounted && isActive(activePath, item.href);
    const className = cn(
      'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200',
      active
        ? 'bg-sidebar-accent text-sidebar-primary'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
    );
    const icon = mounted ? (
      <item.icon className={cn('h-4 w-4 shrink-0', active ? 'text-sidebar-primary' : 'text-muted-foreground')} />
    ) : (
      <span className="inline-block h-4 w-4 shrink-0" />
    );
    return (
      <Link key={item.href} href={item.href} className={className} suppressHydrationWarning>
        {icon}
        {item.label}
      </Link>
    );
  };

  return (
    <nav className="flex-1 space-y-5 overflow-y-auto pb-2">
      <div>
        <div className="mb-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/30">
          Overview
        </div>
        <div className="space-y-0.5">{primaryNav.map(renderItem)}</div>
      </div>
      <div>
        <div className="mb-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/30">
          Research
        </div>
        <div className="space-y-0.5">{researchNav.map(renderItem)}</div>
      </div>
      {mounted && isAdmin ? (
        <div>
          <div className="mb-1 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/30">
            Admin
          </div>
          <div className="space-y-0.5">{adminNav.map(renderItem)}</div>
        </div>
      ) : null}
    </nav>
  );
}
