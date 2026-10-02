'use client';

import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function PageFrame({
  children,
  className,
  padded = true,
  fullHeight = false
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  fullHeight?: boolean;
}) {
  return (
    <div
      className={cn(
        'w-full',
        fullHeight
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
          : 'min-h-0 flex-1 overflow-y-auto',
        padded && 'px-4 py-4 lg:px-5 lg:py-4',
        className
      )}
    >
      {children}
    </div>
  );
}
