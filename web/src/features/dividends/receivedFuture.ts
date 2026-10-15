import type { DividendPayment, FutureHoldingAmount, FutureMonth } from '@portfolio/shared';
import { barLabel } from '../calendar/incomeChartModel';
import { bucketLabel, bucketOf, paymentsInPeriod, receivedBuckets, type Granularity, type HoldingTotal, type ReceivedPeriod } from './receivedSeries';

/** `current` is the period that contains today: received so far plus what is still expected. */
export type PeriodPhase = 'past' | 'current' | 'upcoming';

export interface TimelinePeriod {
  /** Period number (see `bucketOf`). */
  key: number;
  label: string;
  phase: PeriodPhase;
  /** Net amounts in the base currency; `paid` is "Received" in the UI (the calendar's API name). */
  paid: number;
  declared: number;
  estimated: number;
  total: number;
  /** Total per holding (received + declared + estimated), largest first; empty when the breakdown is unknown. */
  holdings: HoldingTotal[];
}

/** The overview's future income: 12 months, and optionally the same per holding. */
export interface FutureIncome {
  months: readonly FutureMonth[];
  byHolding?: readonly FutureHoldingAmount[];
}

const cents = (value: number): number => Math.round(value * 100) / 100;

interface Accumulator {
  paid: number;
  declared: number;
  estimated: number;
  holdings: Map<string, number>;
}

const emptyAccumulator = (): Accumulator => ({ paid: 0, declared: 0, estimated: 0, holdings: new Map() });

function addHolding(acc: Accumulator, symbol: string, amount: number): void {
  acc.holdings.set(symbol, (acc.holdings.get(symbol) ?? 0) + amount);
}

/** First day of a YYYY-MM month. */
const monthStart = (month: string): string => `${month}-01`;

function phaseOf(key: number, current: number): PeriodPhase {
  if (key < current) return 'past';
  return key === current ? 'current' : 'upcoming';
}

function holdingTotals(holdings: ReadonlyMap<string, number>): HoldingTotal[] {
  return [...holdings.entries()]
    .map(([symbol, amount]) => ({ symbol, amount: cents(amount) }))
    .filter((h) => h.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.symbol.localeCompare(b.symbol));
}

/** Received and future amounts (and the holdings behind them) per period number. */
function accumulate(received: readonly DividendPayment[], period: ReceivedPeriod, granularity: Granularity, today: string, future?: FutureIncome): Map<number, Accumulator> {
  const periods = new Map<number, Accumulator>();
  const at = (key: number): Accumulator => {
    const acc = periods.get(key) ?? emptyAccumulator();
    periods.set(key, acc);
    return acc;
  };
  for (const b of receivedBuckets(received, period, granularity, today)) at(b.bucket).paid = b.amount;
  for (const p of paymentsInPeriod(received, period, today)) addHolding(at(bucketOf(p.date, granularity)), p.symbol, p.amount);
  for (const m of future?.months ?? []) {
    const acc = at(bucketOf(monthStart(m.month), granularity));
    acc.declared += m.declared;
    acc.estimated += m.estimated;
  }
  for (const e of future?.byHolding ?? []) addHolding(at(bucketOf(monthStart(e.month), granularity)), e.symbol, e.declared + e.estimated);
  return periods;
}

function toPeriod(key: number, acc: Accumulator, granularity: Granularity, current: number, breakdownKnown: boolean): TimelinePeriod {
  const [paid, declared, estimated] = [cents(acc.paid), cents(acc.declared), cents(acc.estimated)];
  // without the per-holding future amounts a period with future income has no complete breakdown: show none
  const complete = breakdownKnown || declared + estimated === 0;
  return {
    key,
    label: bucketLabel(key, granularity),
    phase: phaseOf(key, current),
    paid,
    declared,
    estimated,
    total: cents(paid + declared + estimated),
    holdings: complete ? holdingTotals(acc.holdings) : [],
  };
}

/**
 * Received history followed by the upcoming 12 months on one axis of months, quarters or years, without gaps.
 * The period that contains today stacks what is received so far with the declared and estimated income still to come,
 * so its bar shows the full expected total. Without `future` the series is the received history only.
 */
export function receivedFutureTimeline(
  received: readonly DividendPayment[],
  period: ReceivedPeriod,
  granularity: Granularity,
  today: string,
  future?: FutureIncome,
): TimelinePeriod[] {
  const periods = accumulate(received, period, granularity, today, future);
  const keys = [...periods.keys()];
  const first = Math.min(...keys);
  const last = Math.max(...keys);
  const current = bucketOf(today, granularity);
  const breakdownKnown = future?.byHolding !== undefined || future === undefined;
  return Array.from({ length: last - first + 1 }, (_, i) => toPeriod(first + i, periods.get(first + i) ?? emptyAccumulator(), granularity, current, breakdownKnown));
}

/** Totals over the timeline, for the headline and the accessible label. */
export function timelineTotals(periods: readonly TimelinePeriod[]): { paid: number; declared: number; estimated: number } {
  let paid = 0;
  let declared = 0;
  let estimated = 0;
  for (const p of periods) {
    paid += p.paid;
    declared += p.declared;
    estimated += p.estimated;
  }
  return { paid: cents(paid), declared: cents(declared), estimated: cents(estimated) };
}

/**
 * The "avg" line: the mean amount RECEIVED per period over the completed periods on the axis (the in-progress and the
 * upcoming periods are left out, they are not complete). Null without a completed period or when nothing was received.
 */
export function averageReceived(periods: readonly TimelinePeriod[]): number | null {
  const done = periods.filter((p) => p.phase === 'past');
  if (done.length === 0) return null;
  const mean = done.reduce((s, p) => s + p.paid, 0) / done.length;
  return mean > 0 ? cents(mean) : null;
}

/** The first and last period that lie completely in the future (the "Upcoming" band); null when there are none. */
export function upcomingBand(periods: readonly TimelinePeriod[]): { from: string; to: string } | null {
  const upcoming = periods.filter((p) => p.phase === 'upcoming');
  const [first] = upcoming;
  const last = upcoming.at(-1);
  return first && last ? { from: first.label, to: last.label } : null;
}

/** Estimated width of one value label at 10 px: characters × 5.5 px plus a gap. */
const LABEL_CHAR_PX = 5.5;
const LABEL_GAP_PX = 4;

/** Bars to step over between two labels so they cannot touch: 1 = every bar, 2 = every other bar. */
export function labelStep(labels: readonly string[], slotPx: number): number {
  const widest = Math.max(0, ...labels.map((l) => l.length));
  return Math.max(1, Math.ceil((widest * LABEL_CHAR_PX + LABEL_GAP_PX) / slotPx));
}

export interface ChartRow extends TimelinePeriod {
  /** Value label above the bar; empty for zero bars and for the bars skipped to keep the labels apart. */
  barLabel: string;
}

/** Adds the value labels (compact EUR above the stack), thinned to every n-th bar when the labels are wider than a bar slot. */
export function chartRows(periods: readonly TimelinePeriod[], currency: string, slotPx: number): ChartRow[] {
  const all = periods.map((p) => barLabel(p.total, currency));
  const step = labelStep(all, slotPx);
  return periods.map((p, i) => ({ ...p, barLabel: i % step === 0 ? all[i]! : '' }));
}

const PHASE_TEXT: Readonly<Record<PeriodPhase, string>> = { past: '', current: 'Current', upcoming: 'Upcoming' };

/** Period name for text: the phase is spelled out so the future is not marked by colour alone. */
export function periodText(p: Pick<TimelinePeriod, 'label' | 'phase'>, withPhase: boolean): string {
  const phase = PHASE_TEXT[p.phase];
  return withPhase && phase ? `${p.label} · ${phase}` : p.label;
}

const NICE_STEPS = [1, 2, 5, 10];

/** A value axis from 0 to a round maximum ≥ `max` with about `count` evenly spaced ticks: the scale the fixed axis and the scrolling bars share. */
export function niceAxis(max: number, count = 4): { max: number; ticks: number[] } {
  if (Number.isNaN(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = (NICE_STEPS.find((n) => n * magnitude >= rough) ?? 10) * magnitude;
  const steps = Math.ceil(max / step - 1e-9);
  return { max: steps * step, ticks: Array.from({ length: steps + 1 }, (_, i) => i * step) };
}
