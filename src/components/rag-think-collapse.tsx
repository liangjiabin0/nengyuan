'use client';

import { useEffect, useState, type ReactNode } from 'react';

const FADE_MS = 160;

export function RagThinkCollapse({
  open,
  children
}: {
  open: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setExpanded(true);
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(() => setExpanded(false), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open || !expanded) return;
    const frame = window.requestAnimationFrame(() => setVisible(true));
    return () => window.cancelAnimationFrame(frame);
  }, [open, expanded]);

  if (!mounted) return null;

  return (
    <div
      className={`rag-think-collapse${expanded ? ' rag-think-collapse-expanded' : ''}${visible ? ' rag-think-collapse-visible' : ''}`}
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      <div className="rag-think-collapse-inner scrollbar-visible">
        {children}
      </div>
    </div>
  );
}
