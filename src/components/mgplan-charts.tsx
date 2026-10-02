'use client';

import { useEffect, useRef } from 'react';

export type MgplanChartView = {
  key: string;
  title: string;
  kind: 'bar' | 'pie' | 'line';
  x: string[];
  series: Array<{ name: string; data: number[] }>;
};

export function MgplanChart({ chart }: { chart: MgplanChartView }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !chart.x.length) return;
    let disposed = false;
    let instance: { resize: () => void; dispose: () => void; setOption: (option: object) => void } | null = null;
    const onResize = () => instance?.resize();
    void import('echarts').then((echarts) => {
      if (disposed || !ref.current) return;
      instance = echarts.init(ref.current);
      const option = chart.kind === 'pie'
        ? {
            tooltip: { trigger: 'item' },
            series: [{
              type: 'pie',
              radius: ['36%', '68%'],
              data: chart.x.map((name, index) => ({ name, value: chart.series[0]?.data[index] || 0 }))
            }]
          }
        : {
            tooltip: { trigger: 'axis' },
            legend: { top: 0, type: 'scroll' },
            grid: { left: 48, right: 16, top: 36, bottom: 48 },
            xAxis: { type: 'category', data: chart.x, axisLabel: { hideOverlap: true } },
            yAxis: { type: 'value', splitLine: { lineStyle: { opacity: 0.35 } } },
            series: chart.series.map((item) => ({
              name: item.name,
              type: chart.kind === 'bar' ? 'bar' : 'line',
              data: item.data,
              showSymbol: chart.x.length < 40,
              areaStyle: chart.kind === 'line' ? { opacity: 0.08 } : undefined
            }))
          };
      instance.setOption(option);
    });
    window.addEventListener('resize', onResize);
    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      instance?.dispose();
    };
  }, [chart]);

  if (!chart.x.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-1 text-xs font-medium text-foreground">{chart.title}</div>
      <div ref={ref} className="h-56 w-full" />
    </div>
  );
}
