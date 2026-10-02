'use client';

import { Download, LoaderCircle, Pencil, Save, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type PreviewKind = 'text' | 'docx' | 'xlsx' | 'pdf' | 'image' | 'binary' | 'empty';

type XlsxSheet = { name: string; rows: string[][] };

function extensionOf(filePath: string) {
  return filePath.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
}

function kindFromPath(filePath: string): PreviewKind {
  const ext = extensionOf(filePath);
  if (['.md', '.txt', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.html', '.htm', '.yaml', '.yml', '.log', '.ndjson'].includes(ext)) {
    return 'text';
  }
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  return 'binary';
}

function isEditableText(filePath: string) {
  return ['.md', '.txt', '.json', '.jsonl', '.csv', '.yaml', '.yml', '.log'].includes(extensionOf(filePath));
}

export function GridGuideFilePreview({
  projectId,
  filePath,
  disabled,
  onError,
  onMouseUp
}: {
  projectId: string;
  filePath: string;
  disabled?: boolean;
  onError?: (message: string) => void;
  onMouseUp?: () => void;
}) {
  const [kind, setKind] = useState<PreviewKind>(filePath ? kindFromPath(filePath) : 'empty');
  const [content, setContent] = useState('');
  const [html, setHtml] = useState('');
  const [sheets, setSheets] = useState<XlsxSheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedRef = useRef(content);

  const rawUrl = useMemo(() => {
    if (!filePath) return '';
    return `/api/grid-guides/${encodeURIComponent(projectId)}/files/preview?path=${encodeURIComponent(filePath)}&raw=1`;
  }, [filePath, projectId]);

  useEffect(() => {
    if (!filePath) {
      setKind('empty');
      setContent('');
      setHtml('');
      setSheets([]);
      setEditing(false);
      return;
    }
    let cancelled = false;
    const nextKind = kindFromPath(filePath);
    setKind(nextKind);
    setEditing(false);
    setLoading(true);
    const load = async () => {
      try {
        if (nextKind === 'pdf' || nextKind === 'image') {
          if (!cancelled) {
            setContent('');
            setHtml('');
            setSheets([]);
          }
          return;
        }
        const response = await fetch(
          `/api/grid-guides/${encodeURIComponent(projectId)}/files/preview?path=${encodeURIComponent(filePath)}`
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '预览失败。');
        if (cancelled) return;
        if (data.kind === 'text') {
          setContent(data.content || '');
          setDraft(data.content || '');
          savedRef.current = data.content || '';
        } else if (data.kind === 'docx') {
          setHtml(data.html || '');
        } else if (data.kind === 'xlsx') {
          setSheets(data.sheets || []);
          setSheetIndex(0);
        } else {
          setContent('');
        }
      } catch (reason) {
        if (!cancelled) onError?.(reason instanceof Error ? reason.message : '预览失败。');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [filePath, onError, projectId]);

  async function save() {
    if (!filePath || disabled || !isEditableText(filePath)) return;
    const next = draftRef.current;
    if (next === savedRef.current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/grid-guides/${encodeURIComponent(projectId)}/files/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content: next })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存失败。');
      setContent(next);
      savedRef.current = next;
      setEditing(false);
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }

  async function downloadFile() {
    if (!filePath) return;
    const response = await fetch(
      `/api/grid-guides/${encodeURIComponent(projectId)}/download?path=${encodeURIComponent(filePath)}`
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      onError?.(data.error || '下载失败。');
      return;
    }
    const blob = await response.blob();
    const name = filePath.split('/').pop() || 'file';
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const fileName = filePath.split('/').pop() || '';
  const markdown = extensionOf(filePath) === '.md';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-white/80 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{fileName || '未选择文件'}</div>
          {filePath ? <div className="truncate text-[10px] text-muted-foreground">{filePath}</div> : null}
        </div>
        {filePath && isEditableText(filePath) ? (
          editing ? (
            <>
              <button
                type="button"
                disabled={disabled || saving}
                onClick={() => void save()}
                className="ui-btn-primary h-8 gap-1.5 text-xs"
              >
                {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                保存
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setDraft(content);
                  setEditing(false);
                }}
                className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" />
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setEditing(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Pencil className="h-3.5 w-3.5" />
              编辑
            </button>
          )
        ) : null}
        {filePath ? (
          <button
            type="button"
            onClick={() => void downloadFile()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" />
            下载
          </button>
        ) : null}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-slate-50/80" onMouseUp={onMouseUp}>
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin text-primary" />
            正在打开文件
          </div>
        ) : kind === 'empty' ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            从左侧选择文件预览。Markdown / JSON / 文本可直接编辑。
          </div>
        ) : kind === 'text' && editing ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void save()}
            disabled={disabled}
            className="h-full min-h-[480px] w-full resize-none bg-white px-5 py-4 font-mono text-[13px] leading-6 text-slate-800 outline-none"
          />
        ) : kind === 'text' && markdown ? (
          <article className="prose prose-slate mx-auto max-w-3xl bg-white px-8 py-8 shadow-sm prose-headings:scroll-mt-4 prose-p:leading-7">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '_空文件_'}</ReactMarkdown>
          </article>
        ) : kind === 'text' ? (
          <pre className="min-h-full whitespace-pre-wrap bg-white px-5 py-4 font-mono text-[13px] leading-6 text-slate-800">
            {content}
          </pre>
        ) : kind === 'docx' ? (
          <div
            className="prose prose-slate mx-auto max-w-3xl bg-white px-8 py-8 shadow-sm"
            dangerouslySetInnerHTML={{ __html: html || '<p>无法预览该 Word 文件。</p>' }}
          />
        ) : kind === 'xlsx' ? (
          <div className="p-4">
            {sheets.length > 1 ? (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {sheets.map((sheet, index) => (
                  <button
                    key={sheet.name}
                    type="button"
                    onClick={() => setSheetIndex(index)}
                    className={`rounded-md px-2.5 py-1 text-xs ${
                      sheetIndex === index ? 'bg-primary text-primary-foreground' : 'bg-white text-muted-foreground'
                    }`}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="overflow-auto rounded-lg border border-border bg-white">
              <table className="min-w-full border-collapse text-left text-xs">
                <tbody>
                  {(sheets[sheetIndex]?.rows || []).map((row, rowIndex) => (
                    <tr key={rowIndex} className={rowIndex === 0 ? 'bg-slate-50 font-medium' : ''}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="border border-slate-200 px-2 py-1.5 align-top text-slate-700">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : kind === 'pdf' ? (
          <iframe title={fileName} src={rawUrl} className="h-full min-h-[720px] w-full bg-slate-200" />
        ) : kind === 'image' ? (
          <div className="flex h-full items-center justify-center p-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={rawUrl} alt={fileName} className="max-h-full max-w-full rounded-lg shadow-sm" />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>该格式暂不支持在线预览。</p>
            <button type="button" onClick={() => void downloadFile()} className="ui-btn-primary h-9 text-xs">
              下载文件
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
