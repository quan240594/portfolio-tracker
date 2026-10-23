import type { EarningsVerdict } from '@portfolio/shared';
import { VERDICT_LABELS } from './earningsModel';

const TONES: Readonly<Record<EarningsVerdict, string>> = {
  beat: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100',
  miss: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-100',
  inline: 'border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
};

function VerdictIcon({ verdict }: Readonly<{ verdict: EarningsVerdict }>) {
  const common = { 'aria-hidden': true, viewBox: '0 0 20 20', className: 'h-3.5 w-3.5 shrink-0', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  if (verdict === 'beat') {
    return (
      <svg {...common}>
        <path d="M10 16V4M5 9l5-5 5 5" />
      </svg>
    );
  }
  if (verdict === 'miss') {
    return (
      <svg {...common}>
        <path d="M10 4v12M5 11l5 5 5-5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 8h12M4 12h12" />
    </svg>
  );
}

/** Beat, miss or in line against the estimate: an icon, the word and the surprise, on a pastel background (never colour alone). */
export function VerdictChip({ verdict, surprise }: Readonly<{ verdict: EarningsVerdict; surprise?: string }>) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${TONES[verdict]}`} data-verdict={verdict}>
      <VerdictIcon verdict={verdict} />
      <span>{VERDICT_LABELS[verdict]}</span>
      {surprise !== undefined && <span className="tabular-nums">{surprise}</span>}
    </span>
  );
}

/** A small neutral badge: `reported`, `calculated`, `GAAP`, `adjusted`. */
export function BasisBadge({ children, title }: Readonly<{ children: string; title?: string }>) {
  return (
    <span title={title} className="inline-flex items-center rounded border border-slate-300 px-1.5 py-px text-[11px] font-medium uppercase tracking-wide text-slate-600 dark:border-slate-600 dark:text-slate-300">
      {children}
    </span>
  );
}
