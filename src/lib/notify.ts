export type NotifyKind = 'success' | 'error' | 'warning' | 'info';

export type NotifyOptions = {
  title?: string;
  duration?: number;
};

export type NotifyItem = {
  id: string;
  kind: NotifyKind;
  title?: string;
  message: string;
  duration: number;
  createdAt: number;
};

const MAX_VISIBLE = 4;
const EMPTY: NotifyItem[] = [];

const DEFAULT_DURATION: Record<NotifyKind, number> = {
  success: 3600,
  info: 4200,
  warning: 5600,
  error: 7200
};

const KIND_TITLE: Record<NotifyKind, string> = {
  success: '已完成',
  error: '操作失败',
  warning: '注意',
  info: '提示'
};

let items: NotifyItem[] = EMPTY;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function nextId() {
  seq += 1;
  return `nt-${Date.now().toString(36)}-${seq.toString(36)}`;
}

function normalizeMessage(message: string) {
  return String(message || '').replace(/\s+/g, ' ').trim();
}

function push(kind: NotifyKind, message: string, options?: NotifyOptions) {
  const text = normalizeMessage(message);
  if (!text) return '';

  const duration = options?.duration ?? DEFAULT_DURATION[kind];
  const title = normalizeMessage(options?.title || '') || KIND_TITLE[kind];
  const existing = items.find((item) => item.kind === kind && item.message === text);
  if (existing) {
    items = items.map((item) =>
      item.id === existing.id
        ? { ...item, title, duration, createdAt: Date.now() }
        : item
    );
    emit();
    return existing.id;
  }

  const item: NotifyItem = {
    id: nextId(),
    kind,
    title,
    message: text,
    duration,
    createdAt: Date.now()
  };
  items = [item, ...items].slice(0, MAX_VISIBLE);
  emit();
  return item.id;
}

export const notify = {
  success(message: string, options?: NotifyOptions) {
    return push('success', message, options);
  },
  error(message: string, options?: NotifyOptions) {
    return push('error', message, options);
  },
  warning(message: string, options?: NotifyOptions) {
    return push('warning', message, options);
  },
  info(message: string, options?: NotifyOptions) {
    return push('info', message, options);
  },
  dismiss(id: string) {
    if (!items.some((item) => item.id === id)) return;
    items = items.filter((item) => item.id !== id);
    if (!items.length) items = EMPTY;
    emit();
  },
  dismissAll() {
    if (!items.length) return;
    items = EMPTY;
    emit();
  }
};

export function subscribeNotify(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNotifySnapshot() {
  return items;
}

export function getNotifyServerSnapshot() {
  return EMPTY;
}

export { KIND_TITLE, DEFAULT_DURATION };
