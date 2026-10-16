"use client";

export function readWorkbenchState<T extends object>(
  userId: string,
  name: string,
): Partial<T> {
  if (!userId || typeof window === "undefined") return {};
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`ai4es:workbench:${userId}:${name}`) || "{}",
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<T>)
      : {};
  } catch {
    return {};
  }
}
export function saveWorkbenchState(
  userId: string,
  name: string,
  value: object,
) {
  if (!userId || typeof window === "undefined") return;
  try {
    localStorage.setItem(
      `ai4es:workbench:${userId}:${name}`,
      JSON.stringify(value),
    );
  } catch {
    /* browser storage can be disabled; server task state remains durable */
  }
}
export function updateWorkbenchUrl(values: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href !== window.location.href)
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
}
