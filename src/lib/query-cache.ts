type CacheEntry<T> = { value: T; expires: number };

const store = new Map<string, CacheEntry<unknown>>();

export function getCached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() < hit.expires) return Promise.resolve(hit.value);
  return loader().then((value) => {
    store.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  });
}

export function invalidateQueryCache(prefix?: string) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
