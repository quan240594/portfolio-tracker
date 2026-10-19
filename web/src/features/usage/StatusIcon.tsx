import type { UsageState } from '@portfolio/shared';

const PATHS: Record<UsageState, React.ReactNode> = {
  ok: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.7 2.7L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  warn: (
    <>
      <path d="M12 3.5L21.5 20h-19z" strokeLinejoin="round" />
      <path d="M12 10v4.5M12 17.2v.1" strokeLinecap="round" />
    </>
  ),
  blocked: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7M14 8.5v7" strokeLinecap="round" />
    </>
  ),
  unavailable: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.8M12 16.6v.1" strokeLinecap="round" />
    </>
  ),
};

/** A distinct shape per state (check, triangle, pause, question mark); always shown next to the state's text. */
export function StatusIcon({ state, className = 'h-4 w-4' }: Readonly<{ state: UsageState; className?: string }>) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={`${className} shrink-0`} fill="none" stroke="currentColor" strokeWidth="2">
      {PATHS[state]}
    </svg>
  );
}

/** Soft status colours, readable in both themes (text, border and fill each keep AA contrast on their own background). */
export const STATE_TONE: Record<UsageState, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950 dark:text-emerald-100',
  warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-100',
  blocked: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950 dark:text-rose-100',
  unavailable: 'border-slate-200 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
};
