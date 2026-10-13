import { useRef, type KeyboardEvent } from 'react';

interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** "tabs" when switching a panel's content (needs `panelId`), "radio" for a pure selector. */
  variant?: 'tabs' | 'radio';
  panelId?: string;
  idPrefix?: string;
  size?: 'sm' | 'md';
}

/** Roving-tabindex segmented control with arrow/Home/End keyboard support. */
export function SegmentedControl<T extends string>({ options, value, onChange, label, variant = 'radio', panelId, idPrefix, size = 'sm' }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const isTabs = variant === 'tabs';

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next === null) return;
    e.preventDefault();
    const opt = options[next];
    if (!opt) return;
    onChange(opt.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role={isTabs ? 'tablist' : 'radiogroup'}
      aria-label={label}
      className="inline-flex flex-wrap gap-0.5 rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800"
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            id={idPrefix ? `${idPrefix}-${opt.value}` : undefined}
            role={isTabs ? 'tab' : 'radio'}
            aria-selected={isTabs ? selected : undefined}
            aria-checked={isTabs ? undefined : selected}
            aria-controls={isTabs ? panelId : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`rounded-md font-medium transition-colors ${size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'} ${
              selected
                ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
