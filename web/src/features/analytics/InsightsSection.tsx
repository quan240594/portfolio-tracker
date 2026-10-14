import type { Insight } from '@portfolio/shared';
import { useAnalyticsSummary } from '../../api/analyticsHooks';
import { Skeleton } from '../../components/Skeleton';
import { usePortfolioScope } from '../portfolios/usePortfolioScope';
import { useDismissedInsights } from './useDismissedInsights';

const SEVERITY_STYLE = {
  warning: 'border-amber-300 bg-amber-50 dark:border-amber-800/70 dark:bg-amber-950/30',
  info: 'border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/30',
} as const;
const SEVERITY_LABEL = { warning: 'Warning', info: 'Info' } as const;
const SEVERITY_ICON = { warning: '▲', info: 'i' } as const;

export function InsightCard({ insight, onDismiss }: Readonly<{ insight: Insight; onDismiss: () => void }>) {
  return (
    <li className={`flex gap-3 rounded-xl border p-3 text-sm ${SEVERITY_STYLE[insight.severity]}`}>
      <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/70 text-[0.65rem] font-bold dark:bg-slate-900/70">
        {SEVERITY_ICON[insight.severity]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          <span className="sr-only">{SEVERITY_LABEL[insight.severity]}: </span>
          {insight.title}
        </p>
        <p className="mt-0.5">{insight.detail}</p>
        {insight.symbols.length > 0 && (
          <ul aria-label="Affected holdings" className="mt-2 flex flex-wrap gap-1.5">
            {insight.symbols.map((s) => (
              <li key={s} className="rounded-md bg-white/70 px-1.5 py-0.5 text-xs font-medium dark:bg-slate-900/70">
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="muted h-6 shrink-0 rounded px-1.5 text-xs hover:bg-white/60 dark:hover:bg-slate-900/60" onClick={onDismiss} aria-label={`Dismiss insight: ${insight.title}`}>
        Dismiss
      </button>
    </li>
  );
}

/** Rule-based portfolio insights; each can be dismissed for the rest of the browser session. */
export function InsightsSection() {
  const { scope, ready } = usePortfolioScope();
  const { data, isPending } = useAnalyticsSummary(scope, { enabled: ready });
  const { dismissed, dismiss, restore } = useDismissedInsights();
  const keyOf = (i: Insight) => `${scope}:${i.id}`;

  if (isPending) {
    return (
      <div aria-hidden="true">
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  const insights = data?.insights ?? [];
  const visible = insights.filter((i) => !dismissed.includes(keyOf(i)));
  const hidden = insights.filter((i) => dismissed.includes(keyOf(i)));
  if (insights.length === 0) return null;

  return (
    <section aria-labelledby="insights-title" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="insights-title" className="font-semibold">
          Portfolio insights
        </h2>
        {hidden.length > 0 && (
          <button type="button" className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => restore(hidden.map(keyOf))}>
            Show {hidden.length} dismissed
          </button>
        )}
      </div>
      {visible.length > 0 && (
        <ul className="grid gap-3 lg:grid-cols-2">
          {visible.map((i) => (
            <InsightCard key={i.id} insight={i} onDismiss={() => dismiss(keyOf(i))} />
          ))}
        </ul>
      )}
    </section>
  );
}
