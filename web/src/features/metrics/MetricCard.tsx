import type { ReactNode } from 'react';
import type { VerdictTone } from '@portfolio/shared';

const CHIP_CLASS: Record<VerdictTone, string> = {
  positive: 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:ring-emerald-900',
  neutral: 'bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-200 dark:ring-sky-900',
  caution: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-900',
  negative: 'bg-red-50 text-red-800 ring-red-200 dark:bg-red-950/50 dark:text-red-200 dark:ring-red-900',
};

export function VerdictChip({ tone, children }: Readonly<{ tone: VerdictTone; children: ReactNode }>) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-medium ring-1 ring-inset ${CHIP_CLASS[tone]}`}>{children}</span>;
}

/** A neutral chip for a value that is not a verdict (the benchmark's return). */
export function Chip({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-medium ring-1 ring-slate-200 ring-inset dark:bg-slate-800 dark:ring-slate-700">
      {children}
    </span>
  );
}

const NOTICE_CLASS = {
  info: 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900',
  warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100',
} as const;

export function Notice({ tone = 'info', children }: Readonly<{ tone?: keyof typeof NOTICE_CLASS; children: ReactNode }>) {
  return <output className={`block rounded-lg border p-3 text-sm ${NOTICE_CLASS[tone]}`}>{children}</output>;
}

function InfoIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v5" strokeLinecap="round" />
      <circle cx="10" cy="6.4" r="0.6" fill="currentColor" />
    </svg>
  );
}

interface CardProps {
  /** Short key of the card ("twr", "pe", …): derives the heading id and the test id. */
  name: string;
  title: string;
  /** The "how is this calculated" text: formula, inputs, data window, caveats. */
  info: ReactNode;
  children: ReactNode;
}

/** One card of the Metrics grid: title, content and a collapsible explanation of the method. */
export function MetricCard({ name, title, info, children }: Readonly<CardProps>) {
  const id = `metric-${name}-title`;
  return (
    <section aria-labelledby={id} className="card flex flex-col gap-4 p-5" data-testid={`metric-${name}`}>
      <h3 id={id} className="text-base font-semibold">
        {title}
      </h3>
      <div className="flex flex-1 flex-col gap-4">{children}</div>
      <details className="muted mt-auto border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
        <summary className="inline-flex cursor-pointer items-center gap-1.5 font-medium select-none hover:text-slate-700 dark:hover:text-slate-200">
          <InfoIcon />
          How this is calculated
        </summary>
        <div className="mt-2 max-w-prose space-y-2 leading-relaxed">{info}</div>
      </details>
    </section>
  );
}

/** The explanation when there is too little history for any figure, or the warning below ~60 weekday returns. */
export function HistoryNotice({ observations, minimum, shortBelow }: Readonly<{ observations: number; minimum: number; shortBelow: number }>) {
  if (observations < minimum) {
    return (
      <Notice>
        Not enough history yet: risk figures need at least {minimum} trading days of returns, you have {observations}.
      </Notice>
    );
  }
  if (observations < shortBelow) {
    return (
      <Notice tone="warning">
        Short history: these figures rest on only {observations} trading days. Below roughly {shortBelow} days they swing widely and say little yet.
      </Notice>
    );
  }
  return null;
}
