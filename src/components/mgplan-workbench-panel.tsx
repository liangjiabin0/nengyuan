'use client';

import { Copy, Download, LoaderCircle, RefreshCw, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNotifyError } from '@/components/app-notify';
import { MgplanChart, type MgplanChartView } from '@/components/mgplan-charts';
import { MgplanMarkdown } from '@/components/mgplan-markdown';
import type { SchemeCanvasSelection } from '@/components/scheme-flow-canvas';
import type { SchemeIdea, SchemeSessionSnapshot } from '@/lib/scheme-solve/types';
import { cn } from '@/lib/utils';

type TabKey = 'case' | 'results' | 'docs' | 'process' | 'compare';

type TableView = {
  key: string;
  file: string;
  label: string;
  headers: string[];
  rows: string[][];
};

type TimeseriesView = {
  key: string;
  file: string;
  label: string;
  exists: boolean;
  rowCount: number;
  headers: string[];
  head: string[][];
  tail: string[][];
  stats: Array<{ column: string; min: number | null; max: number | null; mean: number | null }>;
};

type ResultsView = {
  ideaId: string;
  title: string;
  fixture: boolean;
  ready: boolean;
  health?: { ok?: boolean; error?: string; gurobi?: boolean };
  kpis: Array<{ key: string; label: string; value: number | string | null; unit?: string }>;
  tables: {
    costSummary: Array<Record<string, string>>;
    investment: Array<Record<string, string>>;
    evaluations: Array<Record<string, string>>;
    evaluationsEco: Array<Record<string, string>>;
  };
  charts: MgplanChartView[];
  assets: Array<{ name: string; kind: 'image' | 'html' | 'csv' | 'other'; label: string; url?: string }>;
  process: {
    assumptions: Array<{ name: string; value: string }>;
    modelFiles: string[];
    outputFiles: string[];
    solve: { status: string; engine: string; objective: number | null; elapsedSeconds: number | null; fixture: boolean };
    constraints: string[];
    timeline: Array<{ key: string; label: string; status: string; headline: string; updatedAt?: string }>;
  };
  compare: Array<{ ideaId: string; title: string; fixture: boolean; kpis: Record<string, number | string | null> }>;
  markdown: { design: string; report: string; reviewSmall: string; reviewLarge: string; results: string };
};

function defaultTab(stageKey?: string): TabKey {
  if (stageKey === 'review' || stageKey === 'write' || stageKey === 'report') return 'docs';
  if (stageKey === 'solve') return 'results';
  if (stageKey === 'design' || stageKey === 'model') return 'case';
  return 'results';
}

function formatKpi(value: number | string | null | undefined) {
  if (value == null || value === '') return '—';
  if (typeof value === 'number') return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : String(value);
}

export function MgplanWorkbenchPanel({
  session,
  idea,
  selection,
  busy,
  onClose,
  onResearch,
  onSession,
  onExport
}: {
  session: SchemeSessionSnapshot;
  idea: SchemeIdea;
  selection: SchemeCanvasSelection;
  busy: boolean;
  onClose: () => void;
  onResearch: () => void;
  onSession: (next: SchemeSessionSnapshot) => void;
  onExport: () => void;
}) {
  const [tab, setTab] = useState<TabKey>(defaultTab(selection.stageKey));
  const [tables, setTables] = useState<TableView[]>([]);
  const [timeseries, setTimeseries] = useState<TimeseriesView[]>([]);
  const [results, setResults] = useState<ResultsView | null>(null);
  const [aggregate, setAggregate] = useState<'day' | 'week'>('day');
  const [, setError] = useNotifyError();
  const [saving, setSaving] = useState(false);
  const [solving, setSolving] = useState(false);

  useEffect(() => {
    setTab(defaultTab(selection.stageKey));
  }, [selection.stageKey, idea.id]);

  async function loadCase() {
    const response = await fetch(`/api/scheme-solve/${session.id}/mgplan?ideaId=${idea.id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取算例失败。');
    setTables(data.tables || []);
    setTimeseries(data.timeseries || []);
  }

  async function loadResults(mode = aggregate) {
    const response = await fetch(`/api/scheme-solve/${session.id}/mgplan/results?ideaId=${idea.id}&aggregate=${mode}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取结果失败。');
    setResults(data as ResultsView);
  }

  useEffect(() => {
    let cancelled = false;
    setError('');
    Promise.all([loadCase(), loadResults()]).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '加载规划工作台失败。');
    });
    return () => {
      cancelled = true;
    };
  }, [session.id, idea.id, session.updatedAt]);

  const fileUrl = (name: string, scope: 'output' | 'config' = 'output') =>
    `/api/scheme-solve/${session.id}/mgplan/file?ideaId=${idea.id}&scope=${scope}&name=${encodeURIComponent(name)}`;

  async function saveTables() {
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/scheme-solve/${session.id}/mgplan?ideaId=${idea.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ideaId: idea.id, tables })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存失败。');
      setTables(data.tables || tables);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败。');
    } finally {
      setSaving(false);
    }
  }

  async function uploadSeries(key: string, file: File) {
    const form = new FormData();
    form.set('ideaId', idea.id);
    form.set('key', key);
    form.set('file', file);
    const response = await fetch(`/api/scheme-solve/${session.id}/mgplan/files`, { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '上传失败。');
    if (data.preview) {
      setTimeseries((prev) => prev.map((item) => (item.key === key ? data.preview : item)));
    }
  }

  async function restoreSeries(key: string) {
    const form = new FormData();
    form.set('ideaId', idea.id);
    form.set('key', key);
    form.set('restore', '1');
    const response = await fetch(`/api/scheme-solve/${session.id}/mgplan/files`, { method: 'POST', body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '恢复失败。');
    if (data.preview) {
      setTimeseries((prev) => prev.map((item) => (item.key === key ? data.preview : item)));
    }
  }

  async function solve(allowFixture = false) {
    setSolving(true);
    setError('');
    try {
      const response = await fetch(`/api/scheme-solve/${session.id}/mgplan/solve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ideaId: idea.id, allowFixture })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '求解失败。');
      if (data.session) onSession(data.session);
      await loadResults();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '求解失败。');
    } finally {
      setSolving(false);
    }
  }

  async function cloneScenario() {
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/scheme-solve/${session.id}/mgplan/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ideaId: idea.id })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '复制失败。');
      if (data.session) onSession(data.session);
      setTab('compare');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '复制失败。');
    } finally {
      setSaving(false);
    }
  }

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'case', label: '算例' },
    { key: 'results', label: '结果' },
    { key: 'docs', label: '文档' },
    { key: 'process', label: '过程' },
    { key: 'compare', label: '对比' }
  ];

  const compareRows = results?.compare || [];
  const compareKeys = useMemo(() => ([
    ['investMw', '储能容量 MW'],
    ['investCny', '投资 CNY'],
    ['objective', '综合成本'],
    ['om', '运维'],
    ['spill', '弃电'],
    ['gridBuy', '购电'],
    ['gridUp', '外送'],
    ['gridDown', '受入']
  ] as const), []);

  return (
    <aside className="flex h-full min-h-0 w-[min(72%,980px)] min-w-[420px] shrink-0 flex-col border-l border-border bg-background">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{idea.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            多能规划工作台 · {selection.stageKey === 'write' ? '报告' : selection.stageKey === 'solve' ? '求解' : '算例与结果'}
          </div>
        </div>
        <button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-2">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            className={cn(
              'rounded-full px-2.5 py-1 text-xs',
              tab === item.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
            )}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {results?.fixture ? (
        <div className="border-b border-amber-300/40 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          当前是 zip 样例结果，尚未用本机 Gurobi 重算。可先看完整看板，环境就绪后再点「Gurobi 重算」。
        </div>
      ) : null}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === 'case' ? (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="ui-btn-primary h-8 px-3 text-xs" disabled={saving} onClick={() => void saveTables()}>
                {saving ? <LoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                保存小表
              </button>
              <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" disabled={solving} onClick={() => void solve(false)}>
                {solving ? <LoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                Gurobi 重算
              </button>
            </div>
            {tables.map((table) => (
              <section key={table.key}>
                <h3 className="mb-2 text-sm font-semibold">{table.label}</h3>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr>
                        {table.headers.map((header) => (
                          <th key={header} className="border-b border-border bg-muted/40 px-2 py-1.5 text-left">{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {table.rows.map((row, rowIndex) => (
                        <tr key={`${table.key}-${rowIndex}`}>
                          {table.headers.map((_, colIndex) => (
                            <td key={`${table.key}-${rowIndex}-${colIndex}`} className="border-b border-border/60 px-1 py-0.5">
                              <input
                                className="ui-input h-7 px-1.5 text-xs"
                                value={row[colIndex] || ''}
                                onChange={(event) => {
                                  const next = tables.map((item) => {
                                    if (item.key !== table.key) return item;
                                    const rows = item.rows.map((cells, index) =>
                                      index === rowIndex
                                        ? cells.map((cell, inner) => (inner === colIndex ? event.target.value : cell))
                                        : cells
                                    );
                                    return { ...item, rows };
                                  });
                                  setTables(next);
                                }}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
            {timeseries.map((item) => (
              <section key={item.key} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{item.label}</div>
                    <div className="text-xs text-muted-foreground">{item.file} · {item.rowCount} 行（不提供 8760 单元格编辑）</div>
                  </div>
                  <div className="flex gap-2">
                    <label className="ui-btn-secondary h-8 cursor-pointer px-3 text-xs">
                      <Upload className="mr-1 inline h-3.5 w-3.5" />
                      上传替换
                      <input
                        type="file"
                        accept=".csv,text/csv"
                        className="sr-only"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadSeries(item.key, file).catch((reason) => setError(reason instanceof Error ? reason.message : '上传失败。'));
                          event.target.value = '';
                        }}
                      />
                    </label>
                    <button type="button" className="ui-btn-ghost h-8 px-3 text-xs" onClick={() => void restoreSeries(item.key)}>
                      恢复模板
                    </button>
                  </div>
                </div>
                {item.stats.length ? (
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                    {item.stats.slice(0, 6).map((stat) => (
                      <div key={stat.column}>
                        {stat.column}：min {formatKpi(stat.min)} / max {formatKpi(stat.max)} / mean {formatKpi(stat.mean)}
                      </div>
                    ))}
                  </div>
                ) : null}
                <pre className="mt-2 overflow-x-auto rounded bg-muted/50 p-2 text-[11px] leading-5">
                  {[
                    item.headers.join(', '),
                    ...item.head.map((row) => row.join(', ')),
                    item.rowCount > item.head.length ? '…' : '',
                    ...item.tail.map((row) => row.join(', '))
                  ].filter(Boolean).join('\n')}
                </pre>
              </section>
            ))}
          </div>
        ) : null}

        {tab === 'results' ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" onClick={() => void loadResults()}>刷新结果</button>
              <button
                type="button"
                className={cn('h-8 rounded-md px-3 text-xs', aggregate === 'day' ? 'bg-primary text-primary-foreground' : 'ui-btn-secondary')}
                onClick={() => {
                  setAggregate('day');
                  void loadResults('day');
                }}
              >
                按日
              </button>
              <button
                type="button"
                className={cn('h-8 rounded-md px-3 text-xs', aggregate === 'week' ? 'bg-primary text-primary-foreground' : 'ui-btn-secondary')}
                onClick={() => {
                  setAggregate('week');
                  void loadResults('week');
                }}
              >
                按周
              </button>
              <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" onClick={onExport}>
                <Download className="mr-1 h-3.5 w-3.5" />
                导出
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(results?.kpis || []).map((kpi) => (
                <div key={kpi.key} className="rounded-lg border border-border px-3 py-2">
                  <div className="text-[11px] text-muted-foreground">{kpi.label}</div>
                  <div className="text-sm font-semibold">
                    {formatKpi(kpi.value)}{kpi.unit ? <span className="ml-1 text-xs font-normal text-muted-foreground">{kpi.unit}</span> : null}
                  </div>
                </div>
              ))}
            </div>
            {(results?.charts || []).map((chart) => <MgplanChart key={chart.key} chart={chart} />)}
            {([
              ['investment', '电源/储能投资'],
              ['costSummary', '成本构成'],
              ['evaluationsEco', '经济评价'],
              ['evaluations', '技术评价']
            ] as const).map(([key, title]) => {
              const rows = results?.tables[key] || [];
              if (!rows.length) return null;
              const headers = Object.keys(rows[0] || {});
              return (
                <section key={key}>
                  <h3 className="mb-2 text-sm font-semibold">{title}</h3>
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="min-w-full text-xs">
                      <thead>
                        <tr>
                          {headers.map((header) => (
                            <th key={header} className="border-b border-border bg-muted/40 px-2 py-1.5 text-left">{header}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, index) => (
                          <tr key={`${key}-${index}`}>
                            {headers.map((header) => (
                              <td key={header} className="border-b border-border/60 px-2 py-1.5">{row[header]}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
            <div className="space-y-3">
              {(results?.assets || []).filter((item) => item.kind === 'image').map((asset) => (
                <figure key={asset.name} className="rounded-lg border border-border p-2">
                  <figcaption className="mb-1 text-xs text-muted-foreground">{asset.label}</figcaption>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={asset.url || fileUrl(asset.name)} alt={asset.label} className="max-h-80 w-full rounded object-contain" />
                </figure>
              ))}
              {(results?.assets || []).filter((item) => item.kind === 'html').map((asset) => (
                <div key={asset.name} className="rounded-lg border border-border">
                  <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">{asset.label}</div>
                  <iframe title={asset.label} src={asset.url || fileUrl(asset.name)} className="h-80 w-full bg-white" />
                </div>
              ))}
            </div>
            <MgplanMarkdown content={results?.markdown.results || ''} />
          </div>
        ) : null}

        {tab === 'docs' ? (
          <div className="space-y-6">
            <section>
              <h3 className="mb-2 text-sm font-semibold">结果解读</h3>
              <MgplanMarkdown content={results?.markdown.results || ''} />
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">设计</h3>
              <MgplanMarkdown content={results?.markdown.design || ''} />
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">审查意见</h3>
              <MgplanMarkdown content={[results?.markdown.reviewSmall, results?.markdown.reviewLarge].filter(Boolean).join('\n\n---\n\n')} />
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">技术报告</h3>
              <MgplanMarkdown content={results?.markdown.report || ''} />
            </section>
          </div>
        ) : null}

        {tab === 'process' ? (
          <div className="space-y-4 text-sm">
            <section>
              <h3 className="mb-2 font-semibold">求解状态</h3>
              <ul className="space-y-1 text-xs leading-6">
                <li>引擎：{results?.process.solve.engine || 'openTEPES'}</li>
                <li>状态：{results?.process.solve.status || 'idle'}</li>
                <li>目标值：{formatKpi(results?.process.solve.objective)}</li>
                <li>耗时：{results?.process.solve.elapsedSeconds != null ? `${results.process.solve.elapsedSeconds} s` : '—'}</li>
                <li>来源：{results?.process.solve.fixture ? '样例夹具' : '本次求解'}</li>
              </ul>
            </section>
            <section>
              <h3 className="mb-2 font-semibold">流水线时间线</h3>
              <ol className="space-y-2">
                {(results?.process.timeline || []).map((item) => (
                  <li key={item.key} className="rounded-lg border border-border px-3 py-2 text-xs">
                    <div className="font-medium">{item.label} · {item.status}</div>
                    <div className="text-muted-foreground">{item.headline || '尚未开始'}</div>
                  </li>
                ))}
              </ol>
            </section>
            <section>
              <h3 className="mb-2 font-semibold">输入假设</h3>
              <ul className="grid grid-cols-2 gap-1 text-xs">
                {(results?.process.assumptions || []).map((item) => (
                  <li key={item.name}>{item.name} = {item.value}</li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="mb-2 font-semibold">关键约束</h3>
              <ul className="list-disc space-y-1 pl-5 text-xs">
                {(results?.process.constraints || []).map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>
            <section>
              <h3 className="mb-2 font-semibold">建模文件</h3>
              <p className="text-xs leading-6 text-muted-foreground">{(results?.process.modelFiles || []).join('、') || '尚无'}</p>
            </section>
            <section>
              <h3 className="mb-2 font-semibold">输出文件</h3>
              <p className="text-xs leading-6 text-muted-foreground">{(results?.process.outputFiles || []).join('、') || '尚无'}</p>
            </section>
          </div>
        ) : null}

        {tab === 'compare' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="ui-btn-secondary h-8 px-3 text-xs" disabled={saving} onClick={() => void cloneScenario()}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                复制为对比情景
              </button>
            </div>
            {compareRows.length < 2 ? (
              <p className="text-sm text-muted-foreground">
                同一会话里还没有第二条 mgplan 情景。可复制当前算例后改参数再求解，表格会并排对比投资、成本、储能与购售电。
              </p>
            ) : null}
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="min-w-full text-xs">
                <thead>
                  <tr>
                    <th className="border-b border-border px-2 py-2 text-left">指标</th>
                    {compareRows.map((row) => (
                      <th key={row.ideaId} className="border-b border-border px-2 py-2 text-left">
                        {row.title}{row.fixture ? '（样例）' : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {compareKeys.map(([key, label]) => (
                    <tr key={key}>
                      <td className="border-b border-border/70 px-2 py-1.5">{label}</td>
                      {compareRows.map((row) => (
                        <td key={`${row.ideaId}-${key}`} className="border-b border-border/70 px-2 py-1.5">
                          {formatKpi(row.kpis[key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 gap-2 border-t border-border p-3">
        <button
          type="button"
          className="ui-btn-secondary h-8 flex-1 px-3 text-xs"
          disabled={busy || session.status === 'researching'}
          onClick={onResearch}
        >
          只研究这条想法
        </button>
        <button type="button" className="ui-btn-primary h-8 flex-1 px-3 text-xs" disabled={solving} onClick={() => void solve(false)}>
          {solving ? <LoaderCircle className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          Gurobi 重算
        </button>
      </div>
    </aside>
  );
}
