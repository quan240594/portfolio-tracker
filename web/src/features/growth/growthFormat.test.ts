import type { AnalyticsGrowthResponse, GrowthBenchmark, GrowthHeadline, GrowthMonthRow } from '@portfolio/shared';
import { sp } from '../../test/utils';
import {
  RANGE_LABELS,
  arrowOf,
  availableBenchmarks,
  benchmarkColors,
  dynamicsMonths,
  dynamicsOptions,
  firstBenchmarkValue,
  growthRows,
  headlineText,
  lastBenchmarkValue,
  monthTicks,
  niceAxis,
  percentTickWith,
} from './growthFormat';

const headline = (over: Partial<GrowthHeadline> = {}): GrowthHeadline => ({
  symbol: 'IWDA.AS',
  from: '2025-10-15',
  to: '2026-10-15',
  amount: 1234.5,
  differencePct: 3.4,
  portfolioReturnPct: 12,
  benchmarkReturnPct: 8.6,
  ...over,
});

describe('headlineText', () => {
  it('says ahead of with the money and the percentage points', () => {
    expect(sp(headlineText(headline(), 'EUR'))).toBe('Your portfolio is ahead of IWDA.AS by € 1.234,50 (3,4 percentage points) since 15-10-2025.');
  });

  it('says behind with absolute numbers', () => {
    expect(sp(headlineText(headline({ amount: -80, differencePct: -1.25 }), 'EUR'))).toBe('Your portfolio is behind IWDA.AS by € 80,00 (1,25 percentage points) since 15-10-2025.');
  });

  it('follows the percentage points when the money is exactly level, and says level when both are', () => {
    expect(headlineText(headline({ amount: 0, differencePct: 0.5 }), 'EUR')).toContain('ahead of');
    expect(headlineText(headline({ amount: 0, differencePct: -0.5 }), 'EUR')).toContain('behind');
    expect(headlineText(headline({ amount: 0, differencePct: 0 }), 'EUR')).toBe('Your portfolio is level with IWDA.AS since 15-10-2025.');
  });
});

const bench = (symbol: string, available: boolean, values: [number | null, number | null][]): GrowthBenchmark => ({
  symbol,
  available,
  points: values.map(([value, returnPct]) => ({ value, returnPct })),
  comparison: null,
});
const growth = (benchmarks: GrowthBenchmark[]): AnalyticsGrowthResponse => ({
  range: '1Y',
  baseCurrency: 'EUR',
  period: null,
  series: [
    { date: '2026-01-01', value: 100, invested: 100, returnPct: 0 },
    { date: '2026-01-02', value: 110, invested: 100, returnPct: 10 },
  ],
  benchmarks,
  headline: null,
  monthly: [],
  options: [],
});

describe('chart rows', () => {
  it('aligns benchmark values by index and tolerates short or empty benchmark series', () => {
    const rows = growthRows(
      growth([
        bench('A', true, [
          [100, 0],
          [105, 5],
        ]),
        bench('B', false, []),
      ]),
    );
    expect(rows).toEqual([
      { date: '2026-01-01', value: 100, invested: 100, returnPct: 0, v0: 100, r0: 0, v1: null, r1: null },
      { date: '2026-01-02', value: 110, invested: 100, returnPct: 10, v0: 105, r0: 5, v1: null, r1: null },
    ]);
  });

  it('reads first and last benchmark values', () => {
    const b = bench('A', true, [
      [100, 0],
      [105, 5],
    ]);
    expect([firstBenchmarkValue(b, 'value'), lastBenchmarkValue(b, 'returnPct')]).toEqual([100, 5]);
    expect([firstBenchmarkValue(bench('X', false, []), 'value'), lastBenchmarkValue(bench('X', false, []), 'value')]).toEqual([null, null]);
  });

  it('lists the benchmarks that have data with their response index', () => {
    expect(availableBenchmarks(growth([bench('A', false, []), bench('B', true, []), bench('C', true, [])]))).toEqual([
      { symbol: 'B', index: 1 },
      { symbol: 'C', index: 2 },
    ]);
  });
});

describe('dynamics selection', () => {
  const month = (m: string): GrowthMonthRow => ({ month: m, portfolioPct: 1, benchmarks: {} });
  const monthly = ['2024-11', '2024-12', ...Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`), '2026-01'].map(month);

  it('offers the last 12 months and every year with data', () => {
    expect(dynamicsOptions(monthly)).toEqual([
      { value: '12M', label: 'Last 12 months' },
      { value: '2024', label: '2024' },
      { value: '2025', label: '2025' },
      { value: '2026', label: '2026' },
    ]);
    expect(dynamicsOptions([])).toEqual([{ value: '12M', label: 'Last 12 months' }]);
  });

  it('selects the latest 12 months or the months of a year', () => {
    expect(dynamicsMonths(monthly, '12M').map((m) => m.month)).toEqual([...monthly.slice(-12)].map((m) => m.month));
    expect(dynamicsMonths(monthly, '2024').map((m) => m.month)).toEqual(['2024-11', '2024-12']);
    expect(dynamicsMonths(monthly, '2030')).toEqual([]);
  });
});

describe('axes and labels', () => {
  it('rounds axes around the data and zero', () => {
    expect(niceAxis([2.1, 9.7, -3.2])).toMatchObject({ domain: [-5, 10], ticks: [-5, 0, 5, 10], digits: 0 });
    expect(niceAxis([86, -28], 0.3).domain).toEqual([-50, 150]);
    expect(niceAxis([0.12, 0.31])).toMatchObject({ domain: [0, 0.4], digits: 1 });
    expect(niceAxis([])).toMatchObject({ domain: [0, 0], ticks: [0] });
    expect(niceAxis([-40, -2]).domain).toEqual([-40, 0]);
  });

  it('shows one tick per month, thinned to the maximum', () => {
    const days = Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
    const ticks = monthTicks(days);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(ticks[0]).toBe('2025-01-01');
    expect(new Set(ticks.map((t) => t.slice(0, 7))).size).toBe(ticks.length);
    expect(monthTicks(['2026-01-01', '2026-01-02', '2026-02-01'])).toEqual(['2026-01-01', '2026-02-01']);
    expect(monthTicks([])).toEqual([]);
  });

  it('formats ticks, arrows, colours and range labels', () => {
    expect(percentTickWith(0)(12)).toBe('12%');
    expect(percentTickWith(1)(0.5)).toBe('0,5%');
    expect([arrowOf(1), arrowOf(-1), arrowOf(0)]).toEqual(['▲', '▼', '■']);
    expect(benchmarkColors('light')).toHaveLength(3);
    expect(benchmarkColors('dark')).not.toEqual(benchmarkColors('light'));
    expect(RANGE_LABELS.ALL).toBe('All');
  });
});
