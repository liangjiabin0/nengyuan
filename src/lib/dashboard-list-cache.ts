import { logPageNavMark } from '@/lib/page-nav-log';

const DEFAULT_TTL_MS = 45_000;

type CacheEntry = { value: unknown; expires: number };

const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

export function invalidateDashboardListCache(prefix?: string) {
  if (!prefix) {
    store.clear();
    inflight.clear();
    return;
  }
  for (const key of [...store.keys()]) {
    if (key === prefix || key.startsWith(prefix)) store.delete(key);
  }
  for (const key of [...inflight.keys()]) {
    if (key === prefix || key.startsWith(prefix)) inflight.delete(key);
  }
}

export async function readDashboardListCache<T>(
  key: string,
  loader: () => Promise<T>,
  options?: { ttlMs?: number; force?: boolean }
): Promise<T> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  if (options?.force) invalidateDashboardListCache(key);

  const hit = store.get(key);
  if (hit && Date.now() < hit.expires) {
    logPageNavMark('list-cache-hit', key);
    return hit.value as T;
  }

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  logPageNavMark('list-fetch-start', key);
  const task = loader()
    .then((value) => {
      store.set(key, { value, expires: Date.now() + ttlMs });
      logPageNavMark('list-fetch-end', key);
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}
