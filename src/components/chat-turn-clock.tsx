'use client';

import { useEffect, useState } from 'react';
import {
  formatThinkingClock,
  resolveThinkingDurationMs
} from '@/lib/chat-thinking-duration';

function useNow(active: boolean) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    if (!active) return;
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function ChatTurnClock({
  running,
  durationMs,
  startedAt,
  createdAt,
  previousCreatedAt
}: {
  running?: boolean;
  durationMs?: number;
  startedAt?: number;
  createdAt?: string;
  previousCreatedAt?: string;
}) {
  const now = useNow(Boolean(running));
  const resolvedMs = resolveThinkingDurationMs({
    durationMs,
    startedAt,
    now,
    createdAt,
    previousCreatedAt,
    running
  });
  if (!running && resolvedMs == null) return null;
  return (
    <span
      className={`rag-msg-duration${running ? ' rag-think-label-shimmer' : ''}`}
      aria-live={running ? 'polite' : undefined}
    >
      已运行 {formatThinkingClock(resolvedMs, 1)}
    </span>
  );
}
