"use client";

import { MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import {
  useEffect,
  useState,
  type DragEventHandler,
  type ReactNode,
} from "react";
import { PowerTaskIndicator } from "@/components/power-task-indicator";
import { cn } from "@/lib/utils";

export function WelcomeTypewriter({
  text,
  ready,
}: {
  text: string;
  ready: boolean;
}) {
  const [shown, setShown] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!ready || !text) {
      setShown("");
      setDone(false);
      return;
    }
    setShown("");
    setDone(false);
    let index = 0;
    const timer = window.setInterval(async () => {
      index += 1;
      setShown(text.slice(0, index));
      if (index >= text.length) {
        window.clearInterval(timer);
        setDone(true);
      }
    }, 72);
    return () => window.clearInterval(timer);
  }, [ready, text]);

  if (!ready) return null;

  const glueCount = Math.min(2, shown.length);
  const head = shown.slice(0, shown.length - glueCount);
  const tail = shown.slice(shown.length - glueCount);

  return (
    <p className="whitespace-nowrap text-xl font-medium tracking-tight text-muted-foreground">
      {head ? <span>{head}</span> : null}
      <span>
        {tail}
        {!done ? (
          <span className="rag-welcome-caret" aria-hidden />
        ) : (
          <span
            className="rag-oc-status-dot ml-2.5 align-middle"
            title="能元已连接"
            aria-label="能元已连接"
          />
        )}
      </span>
    </p>
  );
}

export function WorkbenchPageShell({
  crumb,
  title,
  description,
  children,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  dragOverlay,
}: {
  crumb: string;
  title: string;
  description: string;
  children: ReactNode;
  onDragEnter?: DragEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDragLeave?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  dragOverlay?: ReactNode;
}) {
  return (
    <div
      className="rag-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden p-3 md:p-4"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOverlay}
      <div className="mb-3 shrink-0 md:mb-4">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
          {crumb}
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="rag-chat-card min-h-0 flex-1">{children}</div>
    </div>
  );
}

export function WorkbenchSidebar({
  historyOpen,
  search,
  onSearch,
  searchPlaceholder,
  onNew,
  newLabel,
  newDisabled,
  hasItems,
  emptyIcon,
  emptyTitle,
  emptyHint,
  className,
  children,
}: {
  historyOpen: boolean;
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder: string;
  onNew: () => void;
  newLabel: string;
  newDisabled?: boolean;
  hasItems: boolean;
  emptyIcon: ReactNode;
  emptyTitle: string;
  emptyHint: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <aside
      className={cn(
        "rag-conv-list",
        historyOpen ? "flex" : "hidden md:flex",
        className,
      )}
    >
      <div className="shrink-0 space-y-3 border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={searchPlaceholder}
            className="ui-input h-9 pl-9"
          />
        </div>
        <button
          type="button"
          onClick={onNew}
          disabled={newDisabled}
          className="ui-btn-primary h-9 w-full gap-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          {newLabel}
        </button>
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2">
        {hasItems ? (
          <div className="space-y-0.5">{children}</div>
        ) : (
          <div className="flex h-full min-h-48 flex-col items-center justify-center px-4 text-center">
            {emptyIcon}
            <p className="mt-3 text-sm font-medium text-foreground">
              {emptyTitle}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{emptyHint}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

export function WorkbenchConvItem({
  active,
  title,
  time,
  subtitle,
  onOpen,
  onDelete,
  deleteLabel,
}: {
  active: boolean;
  title: string;
  time: string;
  subtitle: string;
  onOpen: () => void;
  onDelete: () => void;
  deleteLabel: string;
}) {
  return (
    <div
      className={cn(
        "group relative",
        active ? "rag-conv-item rag-conv-item-active" : "rag-conv-item",
      )}
    >
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onOpen} className="w-full text-left">
          <div className="flex items-start justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium leading-5 text-foreground">
              {title}
            </span>
            <span className="shrink-0 pt-0.5 text-[10px] leading-4 text-muted-foreground">
              {time}
            </span>
          </div>
        </button>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 flex-1 truncate text-left text-xs leading-4 text-muted-foreground"
          >
            {subtitle}
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground opacity-0 transition hover:text-destructive group-hover:opacity-100"
            aria-label={deleteLabel}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function WorkbenchMain({
  historyOpen,
  children,
}: {
  historyOpen: boolean;
  children: ReactNode;
}) {
  return (
    <main
      className={`min-h-0 min-w-0 flex-1 flex-col ${historyOpen ? "hidden md:flex" : "flex"}`}
    >
      {children}
    </main>
  );
}

export function WorkbenchMainHeader({
  title,
  subtitle,
  onOpenHistory,
  historyLabel = "打开列表",
  actions,
}: {
  title: ReactNode;
  subtitle: string;
  onOpenHistory: () => void;
  historyLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <button
        type="button"
        onClick={onOpenHistory}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent md:hidden"
        aria-label={historyLabel}
      >
        <MessageSquare className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={
            typeof title === "string"
              ? "truncate text-sm font-semibold text-foreground"
              : "text-sm font-semibold text-foreground"
          }
        >
          {title}
        </div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      {actions ? (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1.5">
          {actions}
        </div>
      ) : null}
      <PowerTaskIndicator />
    </header>
  );
}

export function WorkbenchComposer({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 border-t border-border px-4 py-3">{children}</div>
  );
}
