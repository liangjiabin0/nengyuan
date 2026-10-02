import { formatNumber } from '@/lib/utils';

export function StatCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="ui-card group relative flex h-full flex-col justify-between overflow-hidden p-4 transition-all duration-300 hover:border-primary/20 hover:shadow-md">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-bold tracking-tight tabular-nums text-foreground">
        {typeof value === 'number' ? formatNumber(value) : value}
      </div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
