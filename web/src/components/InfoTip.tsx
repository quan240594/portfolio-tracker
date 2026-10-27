import { useEffect, useRef, type ReactNode } from 'react';

/** Default position: against the surrounding (relative) card, near its top. */
const CARD_PANEL = 'absolute inset-x-4 top-12 z-20 sm:right-auto sm:w-80';

interface Props {
  label: string;
  children: ReactNode;
  /** Positioning classes of the panel (it is absolute: the nearest `relative` ancestor is its frame). Default: top of the surrounding card. */
  panelClassName?: string;
}

/**
 * Short "i" disclosure explaining a metric; a native `<details>` so it works with keyboard and screen readers. Escape closes it and puts
 * the focus back on the "i".
 */
export function InfoTip({ label, children, panelClassName = CARD_PANEL }: Readonly<Props>) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const details = ref.current;
    if (!details) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !details.open) return;
      details.open = false;
      details.querySelector('summary')?.focus();
    };
    details.addEventListener('keydown', onKeyDown);
    return () => details.removeEventListener('keydown', onKeyDown);
  }, []);
  return (
    <details ref={ref} className="group">
      <summary
        aria-label={`About ${label}`}
        className="flex h-5 w-5 cursor-pointer list-none items-center justify-center rounded-full border border-slate-300 text-[11px] font-semibold text-slate-500 select-none hover:bg-slate-100 dark:border-slate-600 dark:text-slate-400 dark:hover:bg-slate-800 [&::-webkit-details-marker]:hidden"
      >
        i
      </summary>
      <div className={`${panelClassName} space-y-1.5 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-relaxed font-normal text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300`}>{children}</div>
    </details>
  );
}
