import type { ReactNode } from 'react';

/** Short "i" disclosure explaining a metric; a native `<details>` so it works with keyboard and screen readers. The panel is positioned against the surrounding (relative) card. */
export function InfoTip({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <details className="group">
      <summary
        aria-label={`About ${label}`}
        className="flex h-5 w-5 cursor-pointer list-none items-center justify-center rounded-full border border-slate-300 text-[11px] font-semibold text-slate-500 select-none hover:bg-slate-100 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800 [&::-webkit-details-marker]:hidden"
      >
        i
      </summary>
      <div className="absolute inset-x-4 top-12 z-20 space-y-1.5 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed font-normal text-slate-700 shadow-lg sm:right-auto sm:w-80 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">{children}</div>
    </details>
  );
}
