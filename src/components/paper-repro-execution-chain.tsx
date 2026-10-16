'use client';

import { useState } from 'react';
import { Check, CircleAlert, FileSpreadsheet, FileText, Image as ImageIcon, LoaderCircle, Minus, MoreHorizontal } from 'lucide-react';
import { formatAttachmentSize } from '@/components/attachment-chips';
import type { VirtualSimOutputFile } from '@/components/virtual-sim-output-preview';

export type PaperReproExecutionChainItem = {
  type: 'execution_step';
  stepId: string;
  engine: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'skipped';
  message: string;
  attempt?: number;
  inputArtifacts?: string[];
  outputArtifacts?: string[];
};

const STATUS_LABEL: Record<PaperReproExecutionChainItem['status'], string> = {
  queued: '排队中',
  running: '进行中',
  success: '已完成',
  failed: '失败',
  skipped: '已跳过'
};

function Icon({ status }: { status: PaperReproExecutionChainItem['status'] }) {
  if (status === 'running') return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />;
  if (status === 'success') return <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />;
  if (status === 'failed') return <CircleAlert className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />;
  if (status === 'skipped') return <Minus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
  return <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />;
}

function OutputIcon({ kind }: { kind: VirtualSimOutputFile['kind'] }) {
  if (kind === 'excel') return <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />;
  if (kind === 'html') return <FileText className="h-3.5 w-3.5 text-sky-600" aria-hidden="true" />;
  return <ImageIcon className="h-3.5 w-3.5 text-violet-600" aria-hidden="true" />;
}

export function PaperReproExecutionChain({
  items,
  solverOutput,
  outputs,
  onOpenOutput
}: {
  items: PaperReproExecutionChainItem[];
  solverOutput?: string;
  outputs?: VirtualSimOutputFile[];
  onOpenOutput?: (file: VirtualSimOutputFile) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute right-4 top-16 z-30">
    <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" aria-expanded={open} onClick={() => setOpen(value => !value)}>执行链 {open ? "收起" : "展开"}</button>
    {open ? <aside
      className="absolute right-0 top-10 flex max-h-[60vh] w-[300px] max-w-[85vw] flex-col overflow-auto rounded-xl border border-border bg-background shadow-xl"
      aria-label="论文复现执行链"
    >
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="text-sm font-semibold text-foreground">执行链</div>
        <div className="mt-1 text-xs text-muted-foreground">只显示当前任务的关键状态</div>
      </header>
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!items.length ? (
          <div className="py-8 text-center text-xs text-muted-foreground">等待 Agent 生成执行计划…</div>
        ) : (
          <ol className="space-y-3">
            {items.map((item, index) => (
              <li key={item.stepId} className="relative flex gap-2.5">
                {index < items.length - 1 ? (
                  <span className="absolute left-[7px] top-5 h-[calc(100%+8px)] w-px bg-border" aria-hidden="true" />
                ) : null}
                <span className="relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Icon status={item.status} />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <span className="truncate">{item.message}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground">
                    {STATUS_LABEL[item.status]}{item.attempt && item.attempt > 1 ? ` · 第 ${item.attempt} 次` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {outputs?.length ? (
          <div className="mt-5 border-t border-border pt-3">
            <div className="text-[11px] font-medium text-foreground">求解产物</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">点击或双击预览</div>
            <ul className="mt-2 space-y-1.5">
              {outputs.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    title={`预览 ${file.title}`}
                    onClick={() => onOpenOutput?.(file)}
                    onDoubleClick={() => onOpenOutput?.(file)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onOpenOutput?.(file);
                      }
                    }}
                    className="flex w-full items-start gap-2 rounded-md border border-transparent px-1.5 py-1.5 text-left transition hover:border-border hover:bg-accent"
                  >
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                      <OutputIcon kind={file.kind} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-foreground">{file.title}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {file.name} · {formatAttachmentSize(file.size)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {solverOutput ? (
          <details className="mt-5 border-t border-border pt-3">
            <summary className="cursor-pointer text-[10px] text-muted-foreground">查看求解器原始输出</summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-foreground">
              {solverOutput}
            </pre>
          </details>
        ) : null}
      </div>
    </aside> : null}
    </div>
  );
}
