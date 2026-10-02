'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useNotifyError, useNotifySuccess } from '@/components/app-notify';

type ImportKind = 'excel' | 'disk';

type RagpackInfo = {
  dataRootDir?: string;
  bundleRoot?: string | null;
  bundleActive?: boolean;
};

export function SettingsDataPanel() {
  const [dataRootDir, setDataRootDir] = useState('');
  const [bundleActive, setBundleActive] = useState(false);
  const [bundleRoot, setBundleRoot] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [loadingImport, setLoadingImport] = useState<ImportKind | null>(null);
  const [fast, setFast] = useState(true);
  const [indexChunks, setIndexChunks] = useState(false);
  const [fullRebuild, setFullRebuild] = useState(false);
  const [concurrency, setConcurrency] = useState(4);
  const [jobMessage, setJobMessage] = useState('');
  const [, setMessage] = useNotifySuccess();
  const [, setError] = useNotifyError();

  async function refreshRagpack() {
    const response = await fetch('/api/ragpack');
    const data = (await response.json()) as RagpackInfo & { error?: string };
    if (!response.ok) throw new Error(data.error || '读取便携包状态失败');
    setDataRootDir(data.dataRootDir || '');
    setBundleActive(Boolean(data.bundleActive));
    setBundleRoot(data.bundleRoot || null);
  }

  useEffect(() => {
    refreshRagpack().catch((err) => {
      setError(err instanceof Error ? err.message : '读取数据状态失败');
    });
    fetch('/api/data-import?light=1')
      .then((res) => res.json())
      .then((data) => {
        if (data?.defaults?.concurrency) setConcurrency(Number(data.defaults.concurrency));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (loadingImport !== 'disk') return;
    const timer = setInterval(async () => {
      fetch('/api/data-import?light=1')
        .then((res) => res.json())
        .then((data) => {
          const state = data?.state;
          if (state?.message) setJobMessage(String(state.message));
          if (state?.status === 'done' || state?.status === 'error') {
            if (state.status === 'error') setError(state.error || '导入失败');
            else setMessage(state.message || '磁盘导入完成');
            setLoadingImport(null);
          }
        })
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [loadingImport]);

  async function saveDataRoot() {
    setBusy('save-root');
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataRootDir })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存失败');
      setMessage('数据根目录已保存');
      if (typeof data.dataRootDir === 'string') setDataRootDir(data.dataRootDir);
      await refreshRagpack();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy('');
    }
  }

  async function runImport(kind: ImportKind) {
    setLoadingImport(kind);
    setError('');
    setMessage('');
    setJobMessage(kind === 'disk' ? '正在启动磁盘导入…' : '正在导入表格…');
    try {
      const endpoint = kind === 'excel' ? '/api/ingest' : '/api/data-import';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          kind === 'disk'
            ? { fast, fullRebuild, indexChunks, concurrency, skipCaj: true }
            : {}
        )
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '导入失败');
      if (kind === 'excel') {
        setMessage('Excel/CSV 导入完成');
        setLoadingImport(null);
      } else if (data.state?.status === 'done') {
        setMessage(data.state.message || '磁盘导入完成');
        setLoadingImport(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
      setLoadingImport(null);
    }
  }

  async function exportPack() {
    setBusy('export');
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/ragpack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'export' })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '导出失败');
      const mb = data.result?.sizeBytes ? (data.result.sizeBytes / 1024 / 1024).toFixed(1) : '?';
      setMessage(`导出完成：${mb} MB`);
      await refreshRagpack();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setBusy('');
    }
  }

  async function downloadPack() {
    setBusy('download');
    setError('');
    try {
      const response = await fetch('/api/ragpack', { method: 'PUT' });
      if (!response.ok) throw new Error('下载失败');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'research.ragpack';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败');
    } finally {
      setBusy('');
    }
  }

  async function importPack(file: File) {
    setBusy('import');
    setError('');
    setMessage('');
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/ragpack', { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '导入失败');
      setMessage('便携包导入完成');
      await refreshRagpack();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setBusy('');
    }
  }

  const blocked = Boolean(busy) || loadingImport !== null;

  return (
    <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <section className="space-y-2">
        <div className="text-sm font-semibold text-foreground">数据根目录</div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={dataRootDir}
            onChange={(event) => setDataRootDir(event.target.value)}
            className="ui-input h-9 min-w-0 flex-1 bg-muted/40"
            placeholder="数据"
          />
          <button
            type="button"
            onClick={() => void saveDataRoot()}
            disabled={blocked}
            className="ui-btn-primary h-9 shrink-0 gap-1.5 px-3"
          >
            {busy === 'save-root' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            保存
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {bundleActive
            ? `已加载便携包${bundleRoot ? ` · ${bundleRoot}` : ''}`
            : '未加载便携包时，导入将读取该目录下的原始资料'}
        </p>
      </section>

      <section className="space-y-3 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">数据导入</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void runImport('excel')}
              disabled={blocked}
              className="ui-btn-primary h-8 px-3 text-xs"
            >
              {loadingImport === 'excel' ? '导入中…' : '导入 Excel/CSV'}
            </button>
            <button
              type="button"
              onClick={() => void runImport('disk')}
              disabled={blocked}
              className="ui-btn-secondary h-8 px-3 text-xs"
            >
              {loadingImport === 'disk' ? '导入中…' : '导入磁盘资料'}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-foreground">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} />
            快速导入
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={indexChunks} onChange={(e) => setIndexChunks(e.target.checked)} />
            分块索引
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={fullRebuild} onChange={(e) => setFullRebuild(e.target.checked)} />
            全量重建
          </label>
          <label className="inline-flex items-center gap-2">
            <span className="text-muted-foreground">并发</span>
            <input
              type="range"
              min={1}
              max={16}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="w-28"
            />
            <span className="tabular-nums">{concurrency}</span>
          </label>
        </div>
        {loadingImport === 'disk' && jobMessage ? (
          <div className="rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-800">
            {jobMessage}
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-lg border border-border p-3">
        <div className="text-sm font-semibold text-foreground">便携包 .ragpack</div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void exportPack()}
            disabled={blocked}
            className="ui-btn-primary h-8 px-3 text-xs"
          >
            {busy === 'export' ? '打包中…' : '导出'}
          </button>
          <button
            type="button"
            onClick={() => void downloadPack()}
            disabled={blocked}
            className="ui-btn-secondary h-8 px-3 text-xs"
          >
            {busy === 'download' ? '下载中…' : '下载'}
          </button>
          <label className={`ui-btn-secondary h-8 cursor-pointer px-3 text-xs ${blocked ? 'pointer-events-none opacity-60' : ''}`}>
            {busy === 'import' ? '导入中…' : '导入'}
            <input
              type="file"
              accept=".ragpack,.zip"
              className="hidden"
              disabled={blocked}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importPack(file);
                event.target.value = '';
              }}
            />
          </label>
        </div>
      </section>

    </div>
  );
}
