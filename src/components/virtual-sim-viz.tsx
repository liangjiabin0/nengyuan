'use client';

import { MgplanChart } from '@/components/mgplan-charts';
import type { SimChart, SimKpi, SimTable, SimViz } from '@/lib/virtual-sim/visualize';

function KpiGrid({ items }: { items: SimKpi[] }) {
  if (!items.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map((item) => (
        <div key={item.key} className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <div className="text-[11px] text-muted-foreground">{item.label}</div>
          <div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-foreground">{item.value}</div>
          {item.hint ? <div className="mt-0.5 text-[10px] text-muted-foreground/80">{item.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}

function ResultTable({ table }: { table: SimTable }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">{table.title}</div>
      <div className="scrollbar-thin max-h-56 overflow-auto">
        <table className="w-full min-w-max text-left text-[11px]">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              {table.columns.map((column) => (
                <th key={column} className="px-3 py-1.5 font-medium">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={`${table.key}-${index}`} className="border-t border-border">
                {row.map((cell, cellIndex) => (
                  <td key={`${table.key}-${index}-${cellIndex}`} className="px-3 py-1.5 tabular-nums text-foreground">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function VirtualSimVizPanel({
  viz,
  loading
}: {
  viz: SimViz | null;
  loading?: boolean;
}) {
  if (loading && !viz) {
    return <div className="px-1 py-6 text-center text-xs text-muted-foreground">正在读取仿真结果…</div>;
  }
  if (!viz || (!viz.ready && !viz.kpis.length && !viz.charts.length)) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
        {viz?.summary || '还没有可视化结果。开始仿真后会在这里展开曲线、指标与表格。'}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="text-xs leading-5 text-muted-foreground">{viz.summary}</div>
      <KpiGrid items={viz.kpis} />
      {viz.charts.map((chart: SimChart) => (
        <MgplanChart key={chart.key} chart={chart} />
      ))}
      {viz.tables.map((table) => (
        <ResultTable key={table.key} table={table} />
      ))}
    </div>
  );
}
