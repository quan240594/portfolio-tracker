import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { BENCHMARK_SUGGESTIONS, MAX_GROWTH_BENCHMARKS, type GrowthBenchmark, type GrowthBenchmarkOption } from '@portfolio/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { benchmarkColors } from './growthFormat';

interface Props {
  selected: readonly string[];
  /** Candidates from the API; the suggestions are used until they arrive. */
  options: readonly GrowthBenchmarkOption[] | undefined;
  /** Per selected benchmark whether it has data (from the latest response). */
  benchmarks: readonly GrowthBenchmark[] | undefined;
  onChange: (next: string[]) => void;
}

const FALLBACK_OPTIONS: GrowthBenchmarkOption[] = BENCHMARK_SUGGESTIONS.map((s) => ({ symbol: s.symbol, name: s.name, hasData: true }));

function optionLabel(o: GrowthBenchmarkOption): string {
  return o.name ? `${o.symbol} · ${o.name}` : o.symbol;
}

function Chip({ symbol, color, name, noData, onRemove }: Readonly<{ symbol: string; color: string; name?: string; noData: boolean; onRemove: () => void }>) {
  return (
    <li className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white py-1 pr-1 pl-3 text-sm dark:border-slate-700 dark:bg-slate-950" title={name}>
      <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      <span className="font-medium">{symbol}</span>
      {noData && <span className="rounded bg-amber-100 px-1.5 text-[0.7rem] font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">no data</span>}
      <button
        type="button"
        aria-label={`Remove ${symbol}`}
        onClick={onRemove}
        className="flex h-6 w-6 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white"
      >
        <span aria-hidden="true">×</span>
      </button>
    </li>
  );
}

function OptionButton({ option, selected, disabled, onToggle }: Readonly<{ option: GrowthBenchmarkOption; selected: boolean; disabled: boolean; onToggle: () => void }>) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onToggle()}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <span aria-hidden="true" className="w-4 text-brand-600 dark:text-brand-400">
        {selected ? '✓' : ''}
      </span>
      <span className="min-w-0 flex-1 truncate">{optionLabel(option)}</span>
      {!option.hasData && <span className="muted text-xs">no price data yet</span>}
    </button>
  );
}

function OptionGroup({ label, options, selected, full, onToggle }: Readonly<{ label: string; options: readonly GrowthBenchmarkOption[]; selected: readonly string[]; full: boolean; onToggle: (symbol: string) => void }>) {
  if (options.length === 0) return null;
  return (
    <div role="group" aria-label={label}>
      <div className="muted px-2 pt-2 pb-1 text-xs font-medium">{label}</div>
      {options.map((o) => {
        const isSelected = selected.includes(o.symbol);
        return <OptionButton key={o.symbol} option={o} selected={isSelected} disabled={full && !isSelected} onToggle={() => onToggle(o.symbol)} />;
      })}
    </div>
  );
}

function moveFocus(e: KeyboardEvent<HTMLDivElement>) {
  const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key];
  if (step === undefined) return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  items[Math.min(items.length - 1, Math.max(0, at + step))]?.focus();
}

function Picker({ options, selected, onToggle }: Readonly<{ options: readonly GrowthBenchmarkOption[]; selected: readonly string[]; onToggle: (symbol: string) => void }>) {
  const full = selected.length >= MAX_GROWTH_BENCHMARKS;
  const tracked = options.filter((o) => o.hasData);
  const other = options.filter((o) => !o.hasData);
  return (
    <div className="card absolute left-0 z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] p-2 shadow-lg">
      <div role="listbox" aria-label="Benchmarks" aria-multiselectable="true" onKeyDown={moveFocus} className="max-h-72 overflow-y-auto">
        <OptionGroup label="With price data" options={tracked} selected={selected} full={full} onToggle={onToggle} />
        <OptionGroup label="Suggestions and watchlist without price data" options={other} selected={selected} full={full} onToggle={onToggle} />
      </div>
      <p className="muted px-2 pt-2 text-xs">{full ? `You can compare with at most ${MAX_GROWTH_BENCHMARKS} benchmarks.` : `Choose up to ${MAX_GROWTH_BENCHMARKS} benchmarks.`}</p>
    </div>
  );
}

function NoDataNote({ symbols }: Readonly<{ symbols: readonly string[] }>) {
  if (symbols.length === 0) return null;
  return (
    <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
      No price history is tracked for {symbols.join(', ')}, so {symbols.length === 1 ? 'it is' : 'they are'} left out of the comparison. To add {symbols.length === 1 ? 'it' : 'them'}, put the
      symbol on your{' '}
      <Link to="/watchlist" className="font-medium underline">
        Watchlist
      </Link>
      : prices are tracked for every watchlist symbol and show up here after the next daily price update.
    </p>
  );
}

/** Benchmark chips with a "Select" popover; at most three benchmarks, kept in the URL by the parent. */
export function BenchmarksBar({ selected, options, benchmarks, onChange }: Readonly<Props>) {
  const { theme } = useTheme();
  const colors = benchmarkColors(theme);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const list = options ?? FALLBACK_OPTIONS;
  const noData = selected.filter((s) => benchmarks?.some((b) => b.symbol === s && !b.available));
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, close]);
  const toggle = (symbol: string) => onChange(selected.includes(symbol) ? selected.filter((s) => s !== symbol) : [...selected, symbol]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !open) return;
    close();
    button.current?.focus();
  };

  return (
    <section aria-labelledby="growth-benchmarks-title" className="card p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id="growth-benchmarks-title" className="font-semibold">
          Benchmarks
        </h2>
        <ul aria-label="Selected benchmarks" className="flex flex-1 flex-wrap items-center gap-2">
          {selected.map((s, i) => (
            <Chip key={s} symbol={s} color={colors[i % colors.length]!} name={list.find((o) => o.symbol === s)?.name} noData={noData.includes(s)} onRemove={() => onChange(selected.filter((x) => x !== s))} />
          ))}
          {selected.length === 0 && <li className="muted text-sm">None selected. Select a benchmark to compare your portfolio with.</li>}
        </ul>
        <div ref={wrapper} className="relative" onKeyDown={onKeyDown}>
          <button ref={button} type="button" className="btn-secondary" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            Select
          </button>
          {open && <Picker options={list} selected={selected} onToggle={toggle} />}
        </div>
      </div>
      <NoDataNote symbols={noData} />
    </section>
  );
}
