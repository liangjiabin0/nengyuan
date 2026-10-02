export function isPositiveMs(value?: number): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/** Tool-step sums are usually tens to hundreds of ms; wall-clock turns are longer. */
const TOOL_SUM_LIKE_MS = 1_500;

export function parseChatTimestampMs(value?: string): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  normalized = normalized.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  normalized = normalized.replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(normalized);
  if (Number.isFinite(ms)) return ms;
  const fallback = Date.parse(trimmed);
  return Number.isFinite(fallback) ? fallback : undefined;
}

export function wallClockFromCreatedAt(started?: string, ended?: string): number | undefined {
  const start = parseChatTimestampMs(started);
  const end = parseChatTimestampMs(ended);
  if (start == null || end == null || end <= start) return undefined;
  return end - start;
}

function liveElapsedMs(input: {
  startedAt?: number;
  createdAt?: string;
  now?: number;
}): number | undefined {
  const now = input.now ?? Date.now();
  if (isPositiveMs(input.startedAt)) {
    const elapsed = now - input.startedAt;
    if (elapsed > 0) return elapsed;
  }
  const start = parseChatTimestampMs(input.createdAt);
  if (start == null) return undefined;
  const elapsed = now - start;
  return elapsed > 0 ? elapsed : undefined;
}

function isTrustedStoredDuration(stored?: number, wall?: number) {
  if (!isPositiveMs(stored)) return false;
  if (stored < TOOL_SUM_LIKE_MS && isPositiveMs(wall) && wall > stored * 3) return false;
  return true;
}

export function resolveThinkingDurationMs(input: {
  durationMs?: number;
  startedAt?: number;
  now?: number;
  createdAt?: string;
  previousCreatedAt?: string;
  running?: boolean;
}): number | undefined {
  const stored = isPositiveMs(input.durationMs) ? Math.round(input.durationMs) : undefined;
  const live = liveElapsedMs(input);
  const wall = wallClockFromCreatedAt(input.previousCreatedAt, input.createdAt);

  if (input.running) {
    // meta/done already reported generation time; do not keep counting
    // attachment harvest or stream-close lag.
    if (isTrustedStoredDuration(stored, live)) return stored;
    return isPositiveMs(live) ? Math.round(live) : stored;
  }

  if (isTrustedStoredDuration(stored, wall)) return stored;
  if (isPositiveMs(wall)) return Math.round(wall);
  if (isPositiveMs(stored)) return stored;
  return undefined;
}

export function formatThinkingSeconds(ms?: number, fallbackSec = 1) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return fallbackSec;
  return Math.max(1, Math.round(ms / 1000));
}

/** Under 60s: "12 秒". Otherwise hours/minutes/seconds, omitting zero units. */
export function formatThinkingClock(ms?: number, fallbackSec = 1) {
  const totalSeconds = formatThinkingSeconds(ms, fallbackSec);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

export function freezeThinkingDurationMs(
  message: { thinkingDurationMs?: number; startedAt?: number; createdAt?: string },
  now = Date.now()
) {
  const live = liveElapsedMs({
    startedAt: message.startedAt,
    createdAt: message.createdAt,
    now
  });
  const stored = isPositiveMs(message.thinkingDurationMs) ? Math.round(message.thinkingDurationMs) : undefined;
  if (isTrustedStoredDuration(stored, live)) return stored;
  if (isPositiveMs(live)) return Math.round(live);
  return stored;
}

export function requestWallClockMs(startedAt: number, stored = 0, now = Date.now()) {
  const elapsed = Math.max(1, now - startedAt);
  return Math.max(Math.round(stored) || 0, elapsed);
}

export function previousUserCreatedAt<T extends { role: string; createdAt?: string }>(
  messages: T[],
  index: number
) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item?.role === 'user' && item.createdAt) return item.createdAt;
  }
  return undefined;
}
