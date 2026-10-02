'use client';

import { useEffect, useState } from 'react';
import { formatAttachmentSize } from '@/components/attachment-chips';
import type { LossPreviewKind } from '@/lib/scheme-solve/loss-outputs';

export type VirtualSimOutputFile = {
  id: string;
  kind: LossPreviewKind;
  title: string;
  name: string;
  relative: string;
  size: number;
  mediaType: string;
  previewUrl: string;
  downloadUrl: string;
};

type ExcelSheet = { name: string; rows: string[][] };

export function VirtualSimOutputPreview({
  file,
  onClose
}: {
  file: VirtualSimOutputFile;
  onClose: () => void;
}) {
  const [excel, setExcel] = useState<ExcelSheet[] | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(file.kind === 'excel');

  useEffect(() => {
    if (file.kind !== 'excel') return;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`${file.previewUrl}${file.previewUrl.includes('?') ? '&' : '?'}preview=1`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Excel 预览失败。');
        if (!cancelled) {
          setExcel(Array.isArray(data.sheets) ? data.sheets : []);
          setSheetIndex(0);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Excel 预览失败。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.kind, file.previewUrl]);

  const sheet = excel?.[sheetIndex];

  return (
    <div className="rag-evidence-modal-backdrop" onClick={onClose}>
      <div
        className="rag-evidence-modal rag-evidence-modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label={`预览 ${file.title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-semibold text-foreground">
                {file.kind === 'excel' ? 'XLSX' : file.kind === 'html' ? 'HTML' : 'PNG'}
              </span>
              <span className="text-[11px] text-muted-foreground">{formatAttachmentSize(file.size)}</span>
            </div>
            <h3 className="mt-2 truncate text-base font-semibold leading-6 text-foreground">{file.title}</h3>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{file.name}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a href={file.downloadUrl} className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent">
              下载
            </a>
            <a href={file.previewUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent">
              新窗口打开
            </a>
            <button type="button" onClick={onClose} className="rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent">
              关闭
            </button>
          </div>
        </div>
        <div className="max-h-[calc(min(86vh,820px)-108px)] overflow-hidden bg-muted/20">
          {loading ? <div className="px-5 py-10 text-center text-sm text-muted-foreground">正在加载预览…</div> : null}
          {error ? <div className="px-5 py-10 text-center text-sm text-destructive">{error}</div> : null}
          {!loading && !error && file.kind === 'chart' ? (
            <div className="flex max-h-[calc(min(86vh,820px)-108px)] items-center justify-center overflow-auto p-4">
              <img src={file.previewUrl} alt={file.title} className="max-h-[70vh] max-w-full rounded-md border border-border bg-background object-contain" />
            </div>
          ) : null}
          {!loading && !error && file.kind === 'html' ? (
            <iframe
              title={file.title}
              src={file.previewUrl}
              sandbox="allow-same-origin"
              className="h-[calc(min(86vh,820px)-108px)] w-full bg-background"
            />
          ) : null}
          {!loading && !error && file.kind === 'excel' ? (
            <div className="flex max-h-[calc(min(86vh,820px)-108px)] min-h-[240px] flex-col">
              {excel && excel.length > 1 ? (
                <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2">
                  {excel.map((item, index) => (
                    <button
                      key={item.name}
                      type="button"
                      className={`scheme-inspector-chip shrink-0 ${index === sheetIndex ? 'scheme-inspector-chip-active' : ''}`}
                      onClick={() => setSheetIndex(index)}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
                {sheet?.rows?.length ? (
                  <table className="min-w-full border-collapse text-left text-[11px]">
                    <tbody>
                      {sheet.rows.map((row, rowIndex) => (
                        <tr key={rowIndex} className="border-b border-border/70">
                          {row.map((cell, cellIndex) => (
                            <td key={cellIndex} className={`px-2 py-1.5 ${rowIndex === 0 ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                              {cell ?? ''}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="py-8 text-center text-sm text-muted-foreground">这个工作表是空的。</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
