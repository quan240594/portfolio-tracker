import type { DividendCagrGrowth, DividendGrowthStats, DividendGrowthPeriod, DividendPeriodGrowth } from '@portfolio/shared';
import { formatMoney, formatMonth, formatPercent } from '../../lib/format';

export type StatTone = 'gain' | 'loss' | 'flat' | 'none';

export interface StatTile {
  id: 'qoq' | 'yoy' | 'cagr';
  label: string;
  /** Signed percentage, or "—" when it cannot be calculated. */
  value: string;
  /** ▲ / ▼ shown next to a rising / falling value (the sign stays in `value`, so colour is never the only cue). */
  arrow: string;
  /** Absolute change in the base currency, e.g. "+€ 31,20"; null without a percentage. */
  change: string | null;
  tone: StatTone;
  /** One line: the periods compared, or why there is no figure. */
  subtext: string;
  /** The amounts behind the figure, one line each. */
  amounts: string[];
  /** How the figure is calculated. */
  method: string[];
}

const NONE = '—';
const ARROWS: Record<StatTone, string> = { gain: '▲', loss: '▼', flat: '', none: '' };
/** Growth within ±0.05 points shows as 0,0% and counts as flat. */
const FLAT_UNDER = 0.05;

const SOURCE_NOTE = 'Net of withholding tax, in EUR and converted at the rate of the payment date: the same amounts as the chart and its data table.';

export function toneOf(pct: number | null): StatTone {
  if (pct === null) return 'none';
  if (Math.abs(pct) < FLAT_UNDER) return 'flat';
  return pct > 0 ? 'gain' : 'loss';
}

/** "+€ 31,20" / "−€ 5,00" / "€ 0,00". */
export function signedMoney(amount: number, currency: string): string {
  const abs = formatMoney(Math.abs(amount), currency);
  if (Math.abs(amount) < 0.005) return abs;
  return `${amount > 0 ? '+' : '−'}${abs}`;
}

/** "Q3 2026" for the quarter that starts in `from` (`YYYY-MM`). */
export function quarterLabel(from: string): string {
  return `Q${Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1} ${from.slice(0, 4)}`;
}

const monthRange = (p: DividendGrowthPeriod): string => `${formatMonth(p.from)} – ${formatMonth(p.to)}`;

function periodLabel(basis: DividendPeriodGrowth['basis'], p: DividendGrowthPeriod): string {
  if (basis === 'QUARTER') return quarterLabel(p.from);
  return basis === 'CALENDAR_YEAR' ? p.from.slice(0, 4) : monthRange(p);
}

function figure(pct: number | null, change: number, currency: string): Pick<StatTile, 'value' | 'arrow' | 'change' | 'tone'> {
  const tone = toneOf(pct);
  if (pct === null) return { value: NONE, arrow: '', change: null, tone };
  return { value: formatPercent(tone === 'flat' ? 0 : pct, { signed: true, digits: 1 }), arrow: ARROWS[tone], change: signedMoney(change, currency), tone };
}

function comparisonTile(id: StatTile['id'], label: string, growth: DividendPeriodGrowth | null, currency: string, missing: string, method: string[]): StatTile {
  if (growth === null) return { id, label, value: NONE, arrow: '', change: null, tone: 'none', subtext: missing, amounts: [], method };
  const { basis, current, previous } = growth;
  const [now, before] = [periodLabel(basis, current), periodLabel(basis, previous)];
  const base = { id, label, amounts: [`${now}: ${formatMoney(current.amount, currency)}`, `${before}: ${formatMoney(previous.amount, currency)}`], method };
  const periods = basis === 'CALENDAR_YEAR' ? `${now} vs ${before} (calendar years)` : `${now} vs ${before}`;
  const subtext = growth.pct === null ? `No dividends in ${before} to compare with.` : periods;
  return { ...base, ...figure(growth.pct, growth.change, currency), subtext };
}

const QOQ_METHOD = [
  'Net dividends received in the latest complete calendar quarter compared with the quarter before it. The quarter that is still running is left out.',
  'Growth = latest ÷ previous − 1, and the change is the difference in euros. Without dividends in the earlier quarter there is nothing to compare with, so no percentage is shown.',
  SOURCE_NOTE,
];

const YOY_METHOD = [
  'Net dividends received in the last 12 complete months compared with the 12 months before that (rolling, so it moves every month). The month that is still running is left out.',
  'With fewer than 24 months of history the latest complete calendar year is compared with the year before it; a year in which you started receiving dividends may be incomplete, which makes growth look higher.',
  'Growth = latest ÷ previous − 1. Needs at least 2 years of dividend history.',
  SOURCE_NOTE,
];

const CAGR_METHOD = [
  'Compound annual growth rate of your yearly dividend income, from the first complete calendar year with dividends to the latest complete calendar year: (last ÷ first) ^ (1 ÷ years) − 1, where years is the difference between the two calendar years. The current, partial year is left out at both ends.',
  'If you started receiving dividends part-way through the first year, that year is lower than a full year and growth looks higher. Needs at least 2 complete calendar years.',
  SOURCE_NOTE,
];

export function cagrTile(cagr: DividendCagrGrowth | null, currency: string): StatTile {
  const base = { id: 'cagr' as const, label: 'All-time CAGR', method: CAGR_METHOD };
  if (cagr === null) return { ...base, value: NONE, arrow: '', change: null, tone: 'none', subtext: 'Needs at least 2 complete calendar years of dividends.', amounts: [] };
  const years = cagr.years === 1 ? '1 year' : `${cagr.years} years`;
  return {
    ...base,
    ...figure(cagr.pct, 0, currency),
    change: null,
    subtext: `${cagr.startYear} → ${cagr.endYear} · ${years}`,
    amounts: [`${cagr.startYear} ${formatMoney(cagr.startAmount, currency)} → ${cagr.endYear} ${formatMoney(cagr.endAmount, currency)} over ${years}`],
  };
}

/** The three figures under the Dividend growth chart. */
export function growthTiles(stats: DividendGrowthStats, currency: string): StatTile[] {
  return [
    comparisonTile('qoq', 'Quarter over quarter', stats.qoq, currency, 'Needs at least one complete quarter of dividends.', QOQ_METHOD),
    comparisonTile('yoy', 'Year over year', stats.yoy, currency, 'Needs at least 2 years of dividend history.', YOY_METHOD),
    cagrTile(stats.cagr, currency),
  ];
}
