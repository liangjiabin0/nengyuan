'use client';

import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  Paperclip,
  X
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { ChatAttachment } from '@/lib/chat-attachments';

/** Visible chips before collapsing into “+N / 附件 N”. */
export const ATTACHMENT_CHIP_INLINE_LIMIT = 3;

export type CompactAttachmentItem = {
  key: string;
  name: string;
  size: number;
  extension?: string;
  mediaType?: string;
  statusLabel: string;
  typeLabel: string;
  ready: boolean;
  failed?: boolean;
  busy?: boolean;
  progress?: number;
  error?: string;
  canRemove?: boolean;
};

export function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(0.1, size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentTypeLabel(attachment: Pick<ChatAttachment, 'extension' | 'mediaType'> | {
  extension?: string;
  mediaType?: string;
  name?: string;
}) {
  const fromExt = (attachment.extension || '').replace(/^\./, '');
  if (fromExt) return fromExt.toUpperCase();
  const fromMime = (attachment.mediaType || '').split('/').pop() || '';
  if (fromMime && fromMime !== 'octet-stream') return fromMime.toUpperCase();
  const name = 'name' in attachment ? String(attachment.name || '') : '';
  const index = name.lastIndexOf('.');
  return (index >= 0 ? name.slice(index + 1) : 'FILE').toUpperCase() || 'FILE';
}

export function attachmentStatusLabel(status: ChatAttachment['status']) {
  if (status === 'ready') return '已就绪';
  if (status === 'processing') return '解析中';
  return '处理失败';
}

function shortName(name: string, max = 22) {
  const base = name.trim() || '未命名';
  if (base.length <= max) return base;
  const extIndex = base.lastIndexOf('.');
  if (extIndex > 0 && base.length - extIndex <= 8) {
    const ext = base.slice(extIndex);
    const stem = base.slice(0, extIndex);
    const keep = Math.max(6, max - ext.length - 1);
    return `${stem.slice(0, keep)}…${ext}`;
  }
  return `${base.slice(0, max - 1)}…`;
}

function chipTone(options: {
  inverted?: boolean;
  failed?: boolean;
  busy?: boolean;
  ready?: boolean;
}) {
  if (options.inverted) {
    return options.failed
      ? 'border-rose-300/40 bg-rose-500/15 text-white'
      : 'border-white/20 bg-white/10 text-white hover:bg-white/15';
  }
  if (options.failed) return 'border-destructive/30 bg-destructive/5 text-destructive';
  if (options.busy) return 'border-border/80 bg-muted/60 text-foreground';
  return 'border-border/80 bg-muted/40 text-foreground hover:bg-muted';
}

function StatusDot({
  ready,
  failed,
  busy,
  inverted
}: {
  ready?: boolean;
  failed?: boolean;
  busy?: boolean;
  inverted?: boolean;
}) {
  if (busy) {
    return <LoaderCircle className={`h-3 w-3 shrink-0 animate-spin ${inverted ? 'text-white/80' : 'text-muted-foreground'}`} />;
  }
  if (failed) {
    return <AlertCircle className={`h-3 w-3 shrink-0 ${inverted ? 'text-rose-200' : 'text-destructive'}`} />;
  }
  if (ready) {
    return <CheckCircle2 className={`h-3 w-3 shrink-0 ${inverted ? 'text-white/75' : 'text-success'}`} />;
  }
  return null;
}

function CompactChip({
  item,
  inverted = false,
  onOpen,
  onRemove
}: {
  item: CompactAttachmentItem;
  inverted?: boolean;
  onOpen?: (key: string) => void;
  onRemove?: (key: string) => void;
}) {
  const progress = Math.max(0, Math.min(100, Number(item.progress || 0)));
  const showProgress = Boolean(item.busy && item.progress != null && item.progress < 100);

  return (
    <span
      className={`group relative inline-flex h-6 max-w-[11.5rem] items-center gap-1 overflow-hidden rounded-md border px-1.5 text-[11px] leading-none ${chipTone({
        inverted,
        failed: item.failed,
        busy: item.busy,
        ready: item.ready
      })}`}
      title={item.error || `${item.name} · ${item.typeLabel} · ${formatAttachmentSize(item.size)} · ${item.statusLabel}`}
    >
      {showProgress ? (
        <span
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-0.5 ${inverted ? 'bg-white/20' : 'bg-border'}`}
          aria-hidden
        >
          <span
            className={`block h-full ${inverted ? 'bg-white/80' : 'bg-primary'}`}
            style={{ width: `${progress}%` }}
          />
        </span>
      ) : null}
      <button
        type="button"
        disabled={!item.ready || !onOpen}
        onClick={() => onOpen?.(item.key)}
        className="inline-flex min-w-0 flex-1 items-center gap-1 disabled:cursor-default"
        aria-label={item.ready ? `预览附件 ${item.name}` : `附件 ${item.name}，${item.statusLabel}`}
      >
        <span className={`shrink-0 text-[9px] font-semibold tracking-wide ${inverted ? 'text-white/70' : 'text-muted-foreground'}`}>
          {item.typeLabel.slice(0, 4)}
        </span>
        <span className="min-w-0 truncate font-medium">{shortName(item.name)}</span>
        <StatusDot ready={item.ready} failed={item.failed} busy={item.busy} inverted={inverted} />
      </button>
      {onRemove && item.canRemove !== false ? (
        <button
          type="button"
          onClick={() => onRemove(item.key)}
          disabled={item.busy && item.statusLabel.includes('删除')}
          className={`-mr-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm transition disabled:opacity-40 ${
            inverted ? 'text-white/70 hover:bg-white/15 hover:text-white' : 'text-muted-foreground hover:bg-background hover:text-destructive'
          }`}
          aria-label={`移除附件 ${item.name}`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

function OverflowChip({
  count,
  total,
  inverted = false,
  onClick,
  label
}: {
  count: number;
  total: number;
  inverted?: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium leading-none transition ${chipTone({ inverted })}`}
      aria-label={label || `查看全部 ${total} 个附件`}
      title={label || `查看全部 ${total} 个附件`}
    >
      <Paperclip className="h-3 w-3 opacity-70" />
      <span>{count > 0 ? `+${count}` : `附件 ${total}`}</span>
    </button>
  );
}

export function CompactAttachmentManagerModal({
  title,
  items,
  onClose,
  onPreview,
  onRemove
}: {
  title: string;
  items: CompactAttachmentItem[];
  onClose: () => void;
  onPreview: (key: string) => void;
  onRemove?: (key: string) => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="rag-evidence-modal-backdrop" onClick={onClose}>
      <div
        className="rag-evidence-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-[11px] text-muted-foreground">共 {items.length} 个</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
          >
            关闭
          </button>
        </div>
        <div className="max-h-[min(70vh,560px)] overflow-y-auto px-3 py-2">
          <ul className="divide-y divide-border/70">
            {items.map((item) => (
              <li key={item.key} className="flex items-center gap-2 py-1.5" title={item.error}>
                <button
                  type="button"
                  disabled={!item.ready}
                  onClick={() => onPreview(item.key)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                  aria-label={item.ready ? `预览 ${item.name}` : item.name}
                >
                  <span className="w-8 shrink-0 text-[10px] font-semibold text-muted-foreground">
                    {item.typeLabel.slice(0, 4)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-foreground">{item.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {formatAttachmentSize(item.size)} · {item.statusLabel}
                    </span>
                  </span>
                  <StatusDot ready={item.ready} failed={item.failed} busy={item.busy} />
                </button>
                {onRemove && item.canRemove !== false ? (
                  <button
                    type="button"
                    onClick={() => onRemove(item.key)}
                    disabled={Boolean(item.busy && item.statusLabel.includes('删除'))}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40"
                    aria-label={`移除 ${item.name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function CompactMessageAttachments({
  attachments,
  inverted = false,
  onOpen
}: {
  attachments: ChatAttachment[];
  inverted?: boolean;
  onOpen: (attachment: ChatAttachment) => void;
}) {
  const [managerOpen, setManagerOpen] = useState(false);
  if (!attachments.length) return null;

  const items: CompactAttachmentItem[] = attachments.map((attachment) => ({
    key: attachment.id,
    name: attachment.name,
    size: attachment.size,
    extension: attachment.extension,
    mediaType: attachment.mediaType,
    statusLabel: attachmentStatusLabel(attachment.status),
    typeLabel: attachmentTypeLabel(attachment),
    ready: attachment.status === 'ready',
    failed: attachment.status === 'failed',
    busy: attachment.status === 'processing',
    error: attachment.error
  }));

  const overflow = Math.max(0, items.length - ATTACHMENT_CHIP_INLINE_LIMIT);
  const visible = overflow > 0 ? items.slice(0, ATTACHMENT_CHIP_INLINE_LIMIT) : items;

  return (
    <>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1" aria-label={`附件 ${attachments.length} 个`}>
        {visible.map((item) => (
          <CompactChip
            key={item.key}
            item={item}
            inverted={inverted}
            onOpen={(key) => {
              const attachment = attachments.find((entry) => entry.id === key);
              if (attachment?.status === 'ready') onOpen(attachment);
            }}
          />
        ))}
        {overflow > 0 ? (
          <OverflowChip
            count={overflow}
            total={attachments.length}
            inverted={inverted}
            onClick={() => setManagerOpen(true)}
          />
        ) : null}
      </div>
      {managerOpen ? (
        <CompactAttachmentManagerModal
          title="消息附件"
          items={items}
          onClose={() => setManagerOpen(false)}
          onPreview={(key) => {
            const attachment = attachments.find((entry) => entry.id === key);
            if (attachment?.status === 'ready') {
              setManagerOpen(false);
              onOpen(attachment);
            }
          }}
        />
      ) : null}
    </>
  );
}

export function CompactPendingAttachments({
  items,
  onOpen,
  onRemove,
  onOpenAll,
  footer
}: {
  items: CompactAttachmentItem[];
  onOpen: (key: string) => void;
  onRemove: (key: string) => void;
  onOpenAll: () => void;
  footer?: ReactNode;
}) {
  if (!items.length) return null;
  const overflow = Math.max(0, items.length - ATTACHMENT_CHIP_INLINE_LIMIT);
  const visible = overflow > 0 ? items.slice(0, ATTACHMENT_CHIP_INLINE_LIMIT) : items;

  return (
    <div className="mb-1.5 space-y-1" aria-live="polite">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {visible.map((item) => (
          <CompactChip
            key={item.key}
            item={item}
            onOpen={onOpen}
            onRemove={onRemove}
          />
        ))}
        {overflow > 0 ? (
          <OverflowChip
            count={overflow}
            total={items.length}
            onClick={onOpenAll}
            label={`更多文件 ${overflow} 个，共 ${items.length} 个`}
          />
        ) : null}
      </div>
      {footer}
    </div>
  );
}
