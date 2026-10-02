'use client';

import { BookOpen, Download, GitCompareArrows, ListOrdered, PanelRightClose, Paperclip, Send, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { attachmentTypeLabel, formatAttachmentSize } from '@/components/attachment-chips';
import { FileTypeIcon } from '@/components/file-type-icon';
import type { ChatAttachment } from '@/lib/chat-attachments';
import type { ChatQueuedTurn } from '@/lib/chat-send-queue';
import { cn } from '@/lib/utils';

export type { ChatQueuedTurn };

export type ChatSidePlugin = {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  content: ReactNode;
};

export function ChatSidePluginRail({
  plugins,
  open,
  activeId,
  onOpenChange,
  onActiveIdChange
}: {
  plugins: ChatSidePlugin[];
  open: boolean;
  activeId: string;
  onOpenChange: (open: boolean) => void;
  onActiveIdChange: (id: string) => void;
}) {
  const stripRef = useRef<HTMLElement>(null);
  if (!plugins.length) return null;
  const active = plugins.find((plugin) => plugin.id === activeId) || plugins[0];

  function selectPlugin(id: string) {
    if (open && active.id === id) {
      onOpenChange(false);
      return;
    }
    onActiveIdChange(id);
    onOpenChange(true);
  }

  function closeRail() {
    onOpenChange(false);
    queueMicrotask(() => {
      stripRef.current?.querySelector('button')?.focus();
    });
  }

  return (
    <div className="hidden min-h-0 shrink-0 self-stretch lg:flex">
      <div className="w-px shrink-0 self-stretch bg-border" aria-hidden="true" />
      <div
        className={cn('rag-side-plugin-rail', open && 'rag-side-plugin-rail-open')}
        aria-expanded={open}
      >
        <nav ref={stripRef} className="rag-side-plugin-strip" aria-label="对话侧栏功能">
          {plugins.map((plugin) => {
            const Icon = plugin.icon;
            const selected = open && plugin.id === active.id;
            return (
              <button
                key={plugin.id}
                type="button"
                onClick={() => selectPlugin(plugin.id)}
                className={cn(
                  'relative inline-flex h-8 w-8 items-center justify-center rounded-md transition',
                  selected
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                )}
                aria-pressed={selected}
                aria-label={selected ? `隐藏${plugin.label}` : `打开${plugin.label}`}
                title={selected ? `隐藏${plugin.label}` : plugin.label}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {plugin.badge ? (
                  <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-muted px-0.5 text-[9px] font-semibold leading-none text-foreground">
                    {plugin.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
        <div className="rag-side-plugin-pane" aria-hidden={!open} {...(!open ? { inert: true } : {})}>
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className="truncate text-xs font-medium text-foreground">{active.label}</span>
              {active.badge ? (
                <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold text-foreground">
                  {active.badge}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              tabIndex={open ? 0 : -1}
              onClick={closeRail}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label="隐藏侧栏"
              title="隐藏侧栏"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
            {active.content}
          </div>
        </div>
      </div>
    </div>
  );
}

export type ChatPluginArtifact = {
  id: string;
  fileName: string;
  reportTitle?: string;
  byteSize: number;
};

const PREVIEW_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const PREVIEW_TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yml', '.yaml',
  '.log', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.tex', '.ini', '.toml',
  '.sql', '.r', '.m', '.jl', '.c', '.h', '.cpp', '.go', '.rs', '.sh', '.html', '.htm'
]);

function isPreviewableAttachment(attachment: ChatAttachment) {
  if (attachment.status !== 'ready') return false;
  const ext = String(attachment.extension || '').toLowerCase();
  const mime = String(attachment.mediaType || '').split(';', 1)[0].trim().toLowerCase();
  if (mime.startsWith('image/') || PREVIEW_IMAGE_EXTS.has(ext)) return true;
  if (ext === '.pdf' || mime === 'application/pdf') return true;
  if (ext === '.html' || ext === '.htm' || mime === 'text/html' || mime === 'application/xhtml+xml') return true;
  if (mime.startsWith('text/')) return true;
  return PREVIEW_TEXT_EXTS.has(ext);
}

function FileIconDownloadButton({
  name,
  extension,
  mediaType,
  disabled,
  onDownload
}: {
  name: string;
  extension?: string;
  mediaType?: string;
  disabled?: boolean;
  onDownload: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onDownload}
      className="rag-file-dl-btn"
      aria-label={`下载 ${name}`}
      title="下载"
    >
      <FileTypeIcon
        name={name}
        extension={extension}
        mediaType={mediaType}
        className="rag-file-dl-icon h-9 w-9"
      />
      <span className="rag-file-dl-fx" aria-hidden="true">
        <Download className="rag-file-dl-arrow" strokeWidth={2.4} />
      </span>
    </button>
  );
}

export function ChatAttachmentPluginPanel({
  attachments,
  artifacts = [],
  onPreview,
  onDownloadAttachment,
  onDownloadArtifact
}: {
  attachments: ChatAttachment[];
  artifacts?: ChatPluginArtifact[];
  onPreview: (attachment: ChatAttachment) => void;
  onDownloadAttachment: (attachment: ChatAttachment) => void;
  onDownloadArtifact?: (artifact: ChatPluginArtifact) => void;
}) {
  if (!attachments.length && !artifacts.length) {
    return (
      <div className="flex h-full min-h-72 flex-col items-center justify-center px-5 text-center">
        <div className="rag-knowledge-loader">
          <Paperclip className="h-7 w-7" strokeWidth={1.4} />
        </div>
        <div className="mt-4 text-sm text-muted-foreground">本会话暂无 AI 附件</div>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground/80">
          AI 生成的文件会显示在这里，可预览和下载。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {artifacts.length ? (
        <section className="space-y-2">
          {attachments.length ? (
            <h3 className="px-0.5 text-[11px] font-semibold text-muted-foreground">AI 生成附件</h3>
          ) : null}
          {artifacts.map((artifact) => (
            <div
              key={artifact.id}
              className="flex items-start gap-3 rounded-xl border border-border bg-background px-3 py-2.5"
            >
              <FileIconDownloadButton
                name={artifact.fileName}
                onDownload={() => onDownloadArtifact?.(artifact)}
                disabled={!onDownloadArtifact}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {artifact.fileName}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {attachmentTypeLabel({ name: artifact.fileName })} · {formatAttachmentSize(artifact.byteSize)}
                </div>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {attachments.length ? (
        <section className="space-y-2">
          {artifacts.length ? (
            <h3 className="px-0.5 text-[11px] font-semibold text-muted-foreground">AI 附件</h3>
          ) : null}
          {attachments.map((attachment) => {
            const ready = attachment.status === 'ready';
            const canPreview = isPreviewableAttachment(attachment);
            const meta = `${attachmentTypeLabel(attachment)} · ${formatAttachmentSize(attachment.size)}`;
            return (
              <div
                key={attachment.id}
                className="flex items-start gap-3 rounded-xl border border-border bg-background px-3 py-2.5"
              >
                <FileIconDownloadButton
                  name={attachment.name}
                  extension={attachment.extension}
                  mediaType={attachment.mediaType}
                  disabled={!ready}
                  onDownload={() => onDownloadAttachment(attachment)}
                />
                {canPreview ? (
                  <button
                    type="button"
                    onClick={() => onPreview(attachment)}
                    className="min-w-0 flex-1 rounded-md text-left transition-colors hover:bg-accent/50"
                    title={`预览 ${attachment.name}`}
                  >
                    <div className="truncate text-sm font-medium text-foreground">{attachment.name}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{meta}</div>
                  </button>
                ) : (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{attachment.name}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{meta}</div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}

export type ChatKnowledgePluginItem = {
  key: string;
  citation: string;
  kind: string;
  title: string;
  snippet?: string;
  matchReason?: string;
  isLink: boolean;
};

export function ChatKnowledgePluginPanel({
  items,
  onOpen,
  onOpenGraph
}: {
  items: ChatKnowledgePluginItem[];
  onOpen: (key: string) => void;
  onOpenGraph?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!items.length ? (
          <div className="flex h-full min-h-72 flex-col items-center justify-center px-5 text-center">
            <div className="rag-knowledge-loader">
              <BookOpen className="h-7 w-7" strokeWidth={1.4} />
            </div>
            <div className="mt-4 text-sm text-muted-foreground">本轮暂无知识库链接</div>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground/80">
              检索完成后，相关论文与数据来源会显示在这里。
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onOpen(item.key)}
                className="rag-knowledge-source"
                title={`${item.citation} · ${item.title}`}
              >
                <span className="flex min-w-0 items-start justify-between gap-2">
                  <span
                    className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${
                      item.isLink ? 'bg-blue-100 text-blue-800' : 'bg-emerald-100 text-emerald-800'
                    }`}
                  >
                    {item.citation}
                  </span>
                  <span className="min-w-0 truncate text-[9px] uppercase tracking-wide text-muted-foreground">
                    {item.kind}
                  </span>
                </span>
                <span className="rag-knowledge-source-title">{item.title}</span>
                {item.snippet ? (
                  <span className="rag-knowledge-source-snippet">{item.snippet}</span>
                ) : null}
                {item.matchReason ? (
                  <span className="rag-knowledge-source-meta">{item.matchReason}</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
      {onOpenGraph ? (
        <div className="mt-3 shrink-0 border-t border-border pt-3">
          <button
            type="button"
            onClick={onOpenGraph}
            className="ui-btn-secondary flex w-full items-center justify-center gap-1.5 text-xs"
          >
            <GitCompareArrows className="h-3.5 w-3.5" />
            查看本轮知识图谱
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ChatQueuePluginPanel({
  items,
  onSendNow,
  onRemove
}: {
  items: ChatQueuedTurn[];
  onSendNow: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (!items.length) {
    return (
      <div className="flex h-full min-h-72 flex-col items-center justify-center px-5 text-center">
        <div className="rag-knowledge-loader">
          <ListOrdered className="h-7 w-7" strokeWidth={1.4} />
        </div>
        <div className="mt-4 text-sm text-muted-foreground">暂无排队消息</div>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground/80">
          生成过程中发送的消息会排在这里，回答结束后按顺序发出。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] leading-5 text-muted-foreground">
        当前回答结束后会按顺序发送。点「立刻发送」会打断并马上发这条。
      </p>
      {items.map((item, index) => (
        <article key={item.id} className="rounded-lg border border-border bg-background px-2.5 py-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {index === 0 ? '下一个' : `第 ${index + 1} 条`}
            </span>
            {item.attachments.length ? (
              <span className="truncate text-[10px] text-muted-foreground">
                {item.attachments.length} 个附件
              </span>
            ) : null}
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
            {item.question || '（仅附件）'}
          </p>
          {item.attachments.length ? (
            <ul className="mt-1.5 space-y-0.5">
              {item.attachments.slice(0, 4).map((attachment) => (
                <li key={attachment.id} className="truncate text-[10px] text-muted-foreground">
                  {attachment.name}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2 flex items-center gap-1">
            <button
              type="button"
              onClick={() => onSendNow(item.id)}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground transition hover:bg-primary/90"
              title="打断当前生成并立刻发送"
            >
              <Send className="h-3 w-3" />
              立刻发送
            </button>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
              title="从排队中移除"
              aria-label="从排队中移除"
            >
              <X className="h-3 w-3" />
              移除
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

export const QUEUE_SIDE_PLUGIN_ID = 'send-queue';
export const ATTACHMENT_SIDE_PLUGIN_ID = 'attachments';
export const KNOWLEDGE_SIDE_PLUGIN_ID = 'knowledge';
