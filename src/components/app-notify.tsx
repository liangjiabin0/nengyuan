'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type SetStateAction
} from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import {
  getNotifyServerSnapshot,
  getNotifySnapshot,
  notify,
  subscribeNotify,
  type NotifyItem,
  type NotifyKind
} from '@/lib/notify';
import { cn } from '@/lib/utils';

const ICONS: Record<NotifyKind, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info
};

function useNotifyItems() {
  return useSyncExternalStore(subscribeNotify, getNotifySnapshot, getNotifyServerSnapshot);
}

function NotifyCard({
  item,
  leaving,
  onDismiss
}: {
  item: NotifyItem;
  leaving: boolean;
  onDismiss: (id: string) => void;
}) {
  const Icon = ICONS[item.kind];
  const sticky = item.duration <= 0;
  const cardRef = useRef<HTMLDivElement>(null);
  const [progressKey, setProgressKey] = useState(0);

  useEffect(() => {
    setProgressKey((value) => value + 1);
  }, [item.createdAt, item.duration]);

  useEffect(() => {
    if (sticky || leaving) return;
    const node = cardRef.current;
    const wait = Math.max(1200, Number(item.duration) || 4000);
    let remaining = wait;
    let startedAt = Date.now();
    let timer: number | null = window.setTimeout(() => onDismiss(item.id), remaining);

    function pause() {
      if (timer == null) return;
      window.clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    }

    function resume() {
      if (timer != null || remaining <= 0) return;
      startedAt = Date.now();
      timer = window.setTimeout(() => onDismiss(item.id), remaining);
    }

    node?.addEventListener('mouseenter', pause);
    node?.addEventListener('mouseleave', resume);
    node?.addEventListener('focusin', pause);
    node?.addEventListener('focusout', resume);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      node?.removeEventListener('mouseenter', pause);
      node?.removeEventListener('mouseleave', resume);
      node?.removeEventListener('focusin', pause);
      node?.removeEventListener('focusout', resume);
    };
  }, [item.createdAt, item.duration, item.id, leaving, onDismiss, sticky]);

  return (
    <div
      ref={cardRef}
      className={cn('app-notify-card', `is-${item.kind}`, leaving && 'is-leaving')}
      role={item.kind === 'error' || item.kind === 'warning' ? 'alert' : 'status'}
    >
      <span className="app-notify-accent" aria-hidden="true" />
      <div className="app-notify-icon" aria-hidden="true">
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </div>
      <div className="app-notify-body">
        {item.title ? <div className="app-notify-title">{item.title}</div> : null}
        <p className="app-notify-message">{item.message}</p>
      </div>
      <button
        type="button"
        className="app-notify-close"
        aria-label="关闭通知"
        onClick={() => onDismiss(item.id)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
      {sticky ? null : (
        <span
          key={`${item.id}-${progressKey}`}
          className="app-notify-progress"
          style={{ animationDuration: `${item.duration}ms` }}
        />
      )}
    </div>
  );
}

export function AppNotifyHost() {
  const items = useNotifyItems();
  const [leaving, setLeaving] = useState<Record<string, number>>({});
  const leaveTimers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    const item = getNotifySnapshot().find((entry) => entry.id === id);
    const stamp = item?.createdAt ?? 0;
    if (leaveTimers.current.has(id)) {
      const tracked = leaveTimers.current.get(id);
      if (tracked) window.clearTimeout(tracked);
    }
    setLeaving((current) => (current[id] === stamp ? current : { ...current, [id]: stamp }));
    const timer = window.setTimeout(() => {
      leaveTimers.current.delete(id);
      const latest = getNotifySnapshot().find((entry) => entry.id === id);
      if (latest && latest.createdAt !== stamp) {
        setLeaving((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        return;
      }
      setLeaving((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      notify.dismiss(id);
    }, 180);
    leaveTimers.current.set(id, timer);
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of leaveTimers.current.values()) window.clearTimeout(timer);
      leaveTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    const visible = new Set(items.map((item) => item.id));
    setLeaving((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of Object.keys(next)) {
        if (!visible.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [items]);

  if (!items.length && !Object.keys(leaving).length) return null;

  return (
    <div className="app-notify-region" aria-live="polite" aria-relevant="additions text">
      <div className="app-notify-stack">
        {items.map((item) => (
          <NotifyCard
            key={item.id}
            item={item}
            leaving={leaving[item.id] === item.createdAt}
            onDismiss={dismiss}
          />
        ))}
        {items.length > 1 ? (
          <button type="button" className="app-notify-clear" onClick={() => notify.dismissAll()}>
            全部关闭
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function useNotifyError(initial = '') {
  const [error, setErrorState] = useState(initial);
  const latest = useRef(initial);
  latest.current = error;
  const setError = useCallback((value: SetStateAction<string>) => {
    const next = typeof value === 'function' ? value(latest.current) : value;
    latest.current = next;
    setErrorState(next);
    const text = String(next || '').trim();
    if (text) notify.error(text);
  }, []);
  return [error, setError] as const;
}

export function useNotifySuccess(initial = '') {
  const [message, setMessageState] = useState(initial);
  const latest = useRef(initial);
  latest.current = message;
  const setMessage = useCallback((value: SetStateAction<string>) => {
    const next = typeof value === 'function' ? value(latest.current) : value;
    latest.current = next;
    setMessageState(next);
    const text = String(next || '').trim();
    if (text) notify.success(text);
  }, []);
  return [message, setMessage] as const;
}

export { notify };
export type { NotifyItem, NotifyKind };
