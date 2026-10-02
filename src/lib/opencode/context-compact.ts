import type { ModelContextUsage } from './types';

/** Compact when occupancy reaches this share of the effective window. */
export const CONTEXT_COMPACT_RATIO = 0.78;
/** Force another attempt if the session is this full even after a recent compact. */
export const CONTEXT_COMPACT_CRITICAL_RATIO = 0.9;
const COMPACT_COOLDOWN_MS = 90_000;

const lastCompactAt = new Map<string, number>();

export function contextOccupancyRatio(used?: number, window?: number) {
  if (!used || !window || window <= 0) return 0;
  return used / window;
}

export function shouldCompactContext(
  used?: number,
  window?: number,
  options?: { sessionId?: string; now?: number }
) {
  const ratio = contextOccupancyRatio(used, window);
  if (ratio < CONTEXT_COMPACT_RATIO) return false;
  const sessionId = options?.sessionId?.trim();
  if (!sessionId) return true;
  const previous = lastCompactAt.get(sessionId);
  if (!previous) return true;
  const elapsed = (options?.now ?? Date.now()) - previous;
  if (elapsed < COMPACT_COOLDOWN_MS && ratio < CONTEXT_COMPACT_CRITICAL_RATIO) return false;
  return true;
}

export function markContextCompacted(sessionId?: string, at = Date.now()) {
  if (!sessionId?.trim()) return;
  lastCompactAt.set(sessionId, at);
}

export function compactStatusDetail(ratio: number, compacted: boolean) {
  const percent = Math.round(ratio * 100);
  if (compacted) return `已压缩较早对话，当前占用约 ${percent}%`;
  return `上下文接近上限（${percent}%），正在压缩较早对话…`;
}

export function withCompaction(
  usage: ModelContextUsage | null | undefined,
  extra?: { compacted?: boolean; compactionCount?: number }
): ModelContextUsage | undefined {
  if (!usage || typeof usage.contextTokens !== 'number' || usage.contextTokens <= 0) {
    if (!extra?.compacted && !extra?.compactionCount) return undefined;
    return undefined;
  }
  return {
    ...usage,
    compacted: extra?.compacted || usage.compacted,
    compactionCount: extra?.compactionCount ?? usage.compactionCount
  };
}
