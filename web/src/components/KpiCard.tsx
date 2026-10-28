import { useId, type ReactNode } from 'react';
import { InfoTip } from './InfoTip';
import { Skeleton } from './Skeleton';

interface Props {
  label: string;
  value: ReactNode;
  change?: ReactNode;
  hint?: ReactNode;
  /** Explains the figure; shown as the "i" disclosure next to the label. */
  info?: ReactNode;
  loading?: boolean;
  /** Quiet remark about the card (tooltip and accessible description), e.g. that it ignores the dashboard period. */
  note?: string;
}

export function KpiCard({ label, value, change, hint, info, loading = false, note }: Readonly<Props>) {
  const noteId = useId();
  return (
    <section
      className="card relative flex min-w-0 flex-col gap-1.5 p-4"
      aria-label={label}
      aria-busy={loading || undefined}
      aria-describedby={note ? noteId : undefined}
      title={note}
    >
      {note && (
        <span id={noteId} className="sr-only">
          {note}
        </span>
      )}
      {info ? (
        <div className="flex items-center gap-2">
          <h3 className="muted text-xs font-medium tracking-wide uppercase">{label}</h3>
          <InfoTip label={label}>{info}</InfoTip>
        </div>
      ) : (
        <h3 className="muted text-xs font-medium tracking-wide uppercase">{label}</h3>
      )}
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
