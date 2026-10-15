import { useCallback, useEffect, useId, useRef, useState } from 'react';
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

function OptionCheckbox({ option, selected, disabled, onToggle }: Readonly<{ option: GrowthBenchmarkOption; selected: boolean; disabled: boolean; onToggle: () => void }>) {
  return (
    <label
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-500 dark:hover:bg-slate-800 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      <input type="checkbox" className="sr-only" checked={selected} disabled={disabled} onChange={onToggle} />
      <span aria-hidden="true" className="w-4 text-brand-600 dark:text-brand-400">
        {selected ? '✓' : ''}
      </span>
      <span className="min-w-0 flex-1 truncate">{optionLabel(option)}</span>
      {!option.hasData && <span className="muted text-xs">no price data yet</span>}
    </label>
  );
}

function OptionGroup({ label, options, selected, full, onToggle }: Readonly<{ label: string; options: readonly GrowthBenchmarkOption[]; selected: readonly string[]; full: boolean; onToggle: (symbol: string) => void }>) {
  if (options.length === 0) return null;
  return (
    <fieldset className="min-w-0">
      <legend className="muted px-2 pt-2 pb-1 text-xs font-medium">{label}</legend>
      {options.map((o) => {
        const isSelected = selected.includes(o.symbol);
        return <OptionCheckbox key={o.symbol} option={o} selected={isSelected} disabled={full && !isSelected} onToggle={() => onToggle(o.symbol)} />;
      })}
    </fieldset>
  );
}

function Picker({ id, options, selected, onToggle }: Readonly<{ id: string; options: readonly GrowthBenchmarkOption[]; selected: readonly string[]; onToggle: (symbol: string) => void }>) {
  const full = selected.length >= MAX_GROWTH_BENCHMARKS;
  const tracked = options.filter((o) => o.hasData);
  const other = options.filter((o) => !o.hasData);
  return (
    <div id={id} className="card absolute left-0 z-20 sm:right-0 sm:left-auto mt-2 w-80 max-w-[calc(100vw-2rem)] p-2 shadow-lg">
      <fieldset className="max-h-72 min-w-0 overflow-y-auto">
        <legend className="sr-only">Benchmarks</legend>
        <OptionGroup label="With price data" options={tracked} selected={selected} full={full} onToggle={onToggle} />
        <OptionGroup label="Suggestions and watchlist without price data" options={other} selected={selected} full={full} onToggle={onToggle} />
      </fieldset>
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
  const pickerId = useId();
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
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      button.current?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, close]);
  const toggle = (symbol: string) => onChange(selected.includes(symbol) ? selected.filter((s) => s !== symbol) : [...selected, symbol]);

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
        <div ref={wrapper} className="relative">
          <button ref={button} type="button" className="btn-secondary" aria-controls={open ? pickerId : undefined} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            Select
          </button>
          {open && <Picker id={pickerId} options={list} selected={selected} onToggle={toggle} />}
        </div>
      </div>
      <NoDataNote symbols={noData} />
    </section>
  );
}
