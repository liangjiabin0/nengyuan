'use client';

import { useEffect, useMemo, useState } from 'react';
import { hasRecognizedContextUsage } from '@/lib/opencode/context-usage';
import type { ModelContextUsage } from '@/lib/opencode/types';

type ModelContextInfo = {
  role: 'small' | 'large' | 'storm';
  model: string;
  contextWindow: number;
  source: 'opencode-config' | 'model-endpoint' | 'fallback';
  detectedAt: string;
};

const numberFormatter = new Intl.NumberFormat('zh-CN');

function formatTokens(value?: number) {
  return numberFormatter.format(Math.max(0, Math.round(value || 0)));
}

export function ContextUsageIndicator({
  usage,
  modelRole,
  conversationId,
  conversationKind
}: {
  usage?: ModelContextUsage;
  modelRole: 'small' | 'large' | 'storm';
  conversationId?: string;
  conversationKind: 'chat' | 'research-review';
}) {
  const [info, setInfo] = useState<ModelContextInfo | null>(null);
  const [recoveredUsage, setRecoveredUsage] = useState<ModelContextUsage | undefined>();

  useEffect(() => {
    setInfo(null);
    if (!conversationId) return;

    const controller = new AbortController();
    fetch(`/api/system/model-context?role=${modelRole}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('context probe failed');
        return response.json() as Promise<ModelContextInfo>;
      })
      .then((next) => setInfo(next))
      .catch((error) => {
        if ((error as Error).name === 'AbortError') return;
      });
    return () => controller.abort();
  }, [conversationId, modelRole]);

  useEffect(() => {
    const controller = new AbortController();
    setRecoveredUsage(undefined);
    if (!conversationId) return () => controller.abort();
    const params = new URLSearchParams({ conversationId, kind: conversationKind });
    fetch(`/api/system/context-usage?${params}`, { signal: controller.signal })
      .then(async (response) => response.ok
        ? response.json() as Promise<{ usage?: ModelContextUsage | null }>
        : { usage: null })
      .then((payload) => setRecoveredUsage(hasRecognizedContextUsage(payload.usage) ? payload.usage : undefined))
      .catch(() => undefined);
    return () => controller.abort();
  }, [
    conversationId,
    conversationKind,
    `${usage?.contextTokens ?? ''}:${usage?.modelRounds ?? ''}:${usage?.totalTokens ?? ''}:${usage?.compactionCount ?? ''}`
  ]);

  // Live OpenCode occupancy wins only when the provider actually reported tokens.
  // All-zero step-finish records are treated as unrecognized, not empty context.
  const effectiveUsage = hasRecognizedContextUsage(recoveredUsage)
    ? recoveredUsage
    : hasRecognizedContextUsage(usage)
      ? usage
      : undefined;
  const used = Math.max(0, effectiveUsage?.contextTokens || 0);
  const recognized = hasRecognizedContextUsage(effectiveUsage);
  const total = Math.max(1, info?.contextWindow || 1);
  const ratio = info && recognized ? Math.min(1, used / total) : 0;
  const percent = ratio * 100;
  const circumference = 2 * Math.PI * 10;
  const dashOffset = circumference * (1 - ratio);
  const tone = !recognized ? 'currentColor' : percent >= 90 ? '#ef4444' : percent >= 70 ? '#f59e0b' : '#10b981';
  const summary = !info
    ? '正在探测模型上下文窗口'
    : recognized
      ? `上下文 ${formatTokens(used)} / ${formatTokens(total)} tokens，已使用 ${percent.toFixed(percent >= 10 ? 0 : 1)}%`
      : `已识别上限 ${formatTokens(total)} tokens，本轮占用尚未从模型用量回报中识别`;
  const rows = useMemo(() => [
    ['当前上下文', recognized ? `${formatTokens(used)} tokens` : '尚未识别'],
    ['有效上限', info ? `${formatTokens(total)} tokens` : '探测中'],
    ['累计模型输入', recognized ? `${formatTokens(effectiveUsage?.promptTokens)} tokens` : '尚未识别'],
    ['累计模型输出', recognized ? `${formatTokens(effectiveUsage?.completionTokens)} tokens` : '尚未识别'],
    ['模型轮次', `${effectiveUsage?.modelRounds || 0}`]
  ], [effectiveUsage, info, recognized, total, used]);

  if (!conversationId) return null;

  return (
    <div className="group relative z-50 shrink-0" tabIndex={0} aria-label={summary}>
      <div className="flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-accent group-focus:bg-accent">
        <svg viewBox="0 0 28 28" className="h-7 w-7 -rotate-90" aria-hidden="true">
          <circle cx="14" cy="14" r="10" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-border" />
          <circle
            cx="14"
            cy="14"
            r="10"
            fill="none"
            stroke={tone}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="transition-[stroke-dashoffset] duration-500"
          />
        </svg>
      </div>

      <div
        role="tooltip"
        className="pointer-events-none invisible absolute right-0 top-full z-50 mt-2 w-72 translate-y-1 rounded-md border border-border bg-card p-3 text-card-foreground opacity-0 shadow-lg transition group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus:visible group-focus:translate-y-0 group-focus:opacity-100"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs font-semibold">上下文占用</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {info ? (recognized ? `${percent.toFixed(percent >= 10 ? 0 : 1)}%` : '未识别') : '探测中'}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${percent}%`, backgroundColor: tone }} />
        </div>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[11px]">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="text-right font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 border-t border-border pt-2 text-[10px] leading-4 text-muted-foreground">
          <div className="truncate" title={info?.model ? `Model：${info.model}` : undefined}>
            {info?.model ? `Model：${info.model}` : '正在识别当前模型'}
          </div>
        </div>
      </div>
    </div>
  );
}
