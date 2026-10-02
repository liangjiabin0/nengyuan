'use client';

import { useEffect, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { openDatavScreen } from '@/components/command-screen';
import { useDashboardStats } from '@/components/dashboard-stats-context';
import { PageFrame } from '@/components/page-frame';
import { usePageContentReady } from '@/components/page-nav-loading';
import type { MetricSlice } from '@/lib/dashboard-metrics';
import {
  formatCompact,
  getBaseSlices,
  getCorpusSlices,
  getDiskSlices,
  metricValue,
  sumSlices
} from '@/lib/dashboard-metrics';
import { SystemRuntimeMonitor } from '@/components/system-runtime-monitor';
import { formatNumber } from '@/lib/utils';

function AnimatedNumber({
  value,
  loading,
  compact = false
}: {
  value?: number;
  loading: boolean;
  compact?: boolean;
}) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (loading || value === undefined) return;
    const origin = performance.now();
    const duration = 880;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - origin) / duration);
      const eased = 1 - (1 - t) ** 3;
      setDisplay(Math.round(value * eased));
      if (t < 1) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [loading, value]);

  if (loading || value === undefined) return '—';
  return compact ? formatCompact(display) : formatNumber(display);
}

function Donut({ slices, compact = false }: { slices: MetricSlice[]; compact?: boolean }) {
  const total = Math.max(1, sumSlices(slices));
  const radius = 38;
  const circ = 2 * Math.PI * radius;
  let offset = 0;
  const visible = slices.filter((slice) => slice.value > 0);
  return (
    <svg
      viewBox="0 0 108 108"
      className={compact ? 'h-40 w-40 -rotate-90' : 'h-[240px] w-[240px] -rotate-90 xl:h-[280px] xl:w-[280px]'}
    >
      <circle cx="54" cy="54" r={radius} fill="none" stroke="rgb(229 229 229)" strokeWidth="12" />
      {visible.map((slice) => {
        const dash = (slice.value / total) * circ;
        const current = offset;
        offset += dash;
        return (
          <circle
            key={slice.key}
            cx="54"
            cy="54"
            r={radius}
            fill="none"
            stroke={slice.color}
            strokeWidth="12"
            strokeDasharray={`${dash} ${circ - dash}`}
            strokeDashoffset={-current}
          />
        );
      })}
    </svg>
  );
}

function StackedBar({ slices }: { slices: MetricSlice[] }) {
  const total = Math.max(1, sumSlices(slices));
  return (
    <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
      {slices.map((slice) => (
        <div
          key={slice.key}
          className="h-full"
          style={{ width: `${(slice.value / total) * 100}%`, background: slice.color }}
          title={`${slice.label} ${formatNumber(slice.value)}`}
        />
      ))}
    </div>
  );
}

function KpiCard({
  label,
  value,
  loading
}: {
  label: string;
  value?: number;
  loading: boolean;
}) {
  return (
    <div className="ui-card flex min-h-0 flex-col justify-center gap-1 px-3 py-2.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tracking-tight tabular-nums text-foreground xl:text-2xl">
        <AnimatedNumber value={value} loading={loading} />
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  hint,
  loading
}: {
  label: string;
  value?: number;
  hint?: string;
  loading: boolean;
}) {
  return (
    <div className="flex h-full min-h-[96px] flex-col justify-center rounded-lg border border-border bg-muted/40 px-4 py-3" title={hint}>
      <div className="truncate text-[13px] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-xl font-semibold leading-7 tracking-tight tabular-nums">
        <AnimatedNumber value={value} loading={loading} compact />
      </div>
      {hint ? <div className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground/80">{hint}</div> : null}
    </div>
  );
}

export function HomeDashboard() {
  const { data, loading } = useDashboardStats();
  usePageContentReady(true);

  const corpus = getCorpusSlices(data);
  const disk = getDiskSlices(data);
  const base = getBaseSlices(data);
  const diskTotal = sumSlices(disk);
  const corpusTotal = sumSlices(corpus);

  const architecture = [
    { title: '原始资料', detail: 'PDF / CAJ / 专利 / 书籍 / 导师 / 基金', value: diskTotal },
    { title: '知识底座', detail: '项目、成果、实体与原始记录', value: metricValue(data?.stats.entities) },
    { title: '智能引擎', detail: '图谱关系与检索词项', value: metricValue(data?.indexStats.searchTerms) },
    { title: '应用能力', detail: '问答 · 综述 · 专利 · 国网指南 · 方案求解 · 虚拟仿真 · PPT 配音', value: 7, suffix: '个模块' }
  ];

  return (
    <PageFrame fullHeight className="overflow-hidden max-xl:overflow-y-auto">
      <div className="ui-page-shell flex h-full min-h-0 flex-1 flex-col gap-3 overflow-hidden max-xl:h-auto max-xl:overflow-visible">
        <section className="flex shrink-0 items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-baseline gap-3">
              <h1 className="ui-page-title">科研知识工作台</h1>
              <span className="ui-kicker hidden lg:inline">Dashboard / Overview</span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              用于查看平台收录的科研资料、知识图谱和应用模块概况。
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => openDatavScreen()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-slate-950 px-3.5 text-sm font-medium text-cyan-100 shadow-sm transition hover:bg-slate-800"
            >
              <Maximize2 className="h-4 w-4" />
              展览模式
            </button>
          </div>
        </section>

        <section className="grid shrink-0 grid-cols-7 gap-2">
          <KpiCard label="论文" value={data?.papers} loading={loading} />
          <KpiCard label="专利" value={data?.patents} loading={loading} />
          <KpiCard label="书籍" value={data?.books ?? data?.whitepapers} loading={loading} />
          <KpiCard label="导师" value={data?.mentors} loading={loading} />
          <KpiCard label="项目" value={data?.stats.projects} loading={loading} />
          <KpiCard label="关系边" value={data?.stats.edges} loading={loading} />
          <KpiCard label="检索词项" value={data?.indexStats.searchTerms} loading={loading} />
        </section>

        <section className="grid min-h-0 flex-1 gap-3 overflow-hidden max-xl:flex-none max-xl:overflow-visible xl:grid-cols-2">
          <div className="ui-card flex min-h-0 flex-col overflow-hidden p-5 max-xl:min-h-[420px] xl:p-6">
            <SystemRuntimeMonitor />
          </div>

          <div className="ui-card flex min-h-0 flex-col overflow-hidden p-5 max-xl:min-h-[580px] xl:p-6">
            <div className="flex shrink-0 items-start justify-between gap-4">
              <div>
                <div className="ui-kicker">Knowledge Base</div>
                <h2 className="mt-1 text-xl font-semibold tracking-tight">知识底座</h2>
              </div>
              <div className="text-right">
                <div className="text-xs text-muted-foreground">资产合计</div>
                <div className="mt-0.5 text-xl font-semibold tabular-nums">
                  {loading ? '—' : formatNumber(corpusTotal)}
                </div>
              </div>
            </div>

            <div className="mt-5 flex shrink-0 items-center gap-8">
              <div className="relative shrink-0">
                <Donut slices={corpus} compact />
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-xs text-muted-foreground">资产</span>
                  <span className="text-lg font-semibold tabular-nums">
                    {loading ? '—' : formatNumber(corpusTotal)}
                  </span>
                </div>
              </div>
              <div className="grid min-w-0 flex-1 grid-cols-3 gap-x-4 gap-y-3">
                {corpus.map((slice) => (
                  <div key={slice.key} className="min-w-0" title={slice.hint}>
                    <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: slice.color }} />
                      <span className="truncate">{slice.label}</span>
                    </div>
                    <div className="mt-0.5 pl-3.5 text-lg font-semibold tabular-nums">
                      {loading ? '—' : formatNumber(slice.value)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 shrink-0">
              <div className="mb-1.5 flex items-center justify-between text-[13px]">
                <span className="text-muted-foreground">磁盘源文件</span>
                <span className="tabular-nums text-foreground">{loading ? '—' : formatNumber(diskTotal)}</span>
              </div>
              <StackedBar slices={disk} />
            </div>

            <div className="mt-5 grid min-h-0 flex-1 grid-cols-2 content-stretch gap-3">
              {base.map((item) => (
                <MetricTile
                  key={item.key}
                  label={item.label}
                  value={item.value}
                  hint={item.hint}
                  loading={loading}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="ui-card shrink-0 p-3">
          <div className="mb-1.5 flex items-end justify-between gap-3">
            <div>
              <div className="ui-kicker">Architecture</div>
              <h2 className="ui-section-title mt-0.5">系统架构</h2>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            {architecture.map((layer, index) => (
              <div key={layer.title} className="relative rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold tabular-nums text-muted-foreground/70">
                      0{index + 1}
                    </div>
                    <div className="mt-0.5 text-sm font-medium">{layer.title}</div>
                    <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{layer.detail}</div>
                  </div>
                  <div className="shrink-0 text-base font-semibold tabular-nums xl:text-lg">
                    {loading ? '—' : layer.suffix ? `${layer.value} ${layer.suffix}` : formatNumber(layer.value)}
                  </div>
                </div>
                {index < architecture.length - 1 ? (
                  <span className="pointer-events-none absolute -right-2 top-1/2 hidden h-px w-4 bg-border md:block" />
                ) : null}
              </div>
            ))}
          </div>
        </section>
      </div>
    </PageFrame>
  );
}
