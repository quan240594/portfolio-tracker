import type { ReactNode } from 'react';
import { Skeleton } from './Skeleton';

interface Props {
  label: string;
  value: ReactNode;
  change?: ReactNode;
  hint?: ReactNode;
  loading?: boolean;
}

export function KpiCard({ label, value, change, hint, loading = false }: Props) {
  return (
    <section className="card flex flex-col gap-1.5 p-4" aria-label={label} aria-busy={loading || undefined}>
      <h3 className="muted text-xs font-medium tracking-wide uppercase">{label}</h3>
      {loading ? (
        <>
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-20" />
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold tracking-tight tabular-nums" data-testid="kpi-value">
            {value}
          </p>
          {change && <div className="text-sm">{change}</div>}
          {hint && <p className="muted text-xs">{hint}</p>}
        </>
      )}
    </section>
  );
}
