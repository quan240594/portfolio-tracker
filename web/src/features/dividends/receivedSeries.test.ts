import type { AnalyticsDividendGrowthResponse, DividendPayment } from '@portfolio/shared';
import { formatMonth } from '../../lib/format';
import { paymentsInPeriod, receivedByHolding, receivedSeries, yearComparison } from './receivedSeries';

const TODAY = '2026-10-15';
const payment = (date: string, amount: number, symbol = 'AAA'): DividendPayment => ({ symbol, date, perShareLocal: 1, currency: 'EUR', amount, status: 'RECEIVED' });
const received = [
  payment('2025-03-01', 100),
  payment('2025-11-20', 10, 'BBB'),
  payment('2026-02-10', 20),
  payment('2026-03-05', 5, 'BBB'),
  payment('2026-05-20', 15),
  payment('2026-09-30', 7),
  payment('2026-10-10', 3, 'BBB'),
  payment('2026-12-01', 999), // not paid yet
];
const amounts = (series: { amount: number }[]) => series.map((b) => b.amount);

describe('paymentsInPeriod', () => {
  it('filters on the period that ends today', () => {
    expect(paymentsInPeriod(received, 'all', TODAY)).toHaveLength(7);
    expect(paymentsInPeriod(received, '12m', TODAY).map((p) => p.date)).toEqual(['2025-11-20', '2026-02-10', '2026-03-05', '2026-05-20', '2026-09-30', '2026-10-10']);
    expect(paymentsInPeriod(received, 'ytd', TODAY)).toHaveLength(5);
    expect(paymentsInPeriod(received, '12m', '2026-01-10').map((p) => p.date)).toEqual(['2025-03-01', '2025-11-20']);
  });
});

describe('receivedSeries', () => {
  it('has a continuous monthly axis from the first payment to this month', () => {
    const series = receivedSeries(received, 'all', 'month', TODAY);
    expect(series).toHaveLength(20);
    expect(series[0]).toEqual({ label: formatMonth('2025-03'), amount: 100 });
    expect(series.at(-1)).toEqual({ label: formatMonth('2026-10'), amount: 3 });
    expect(series[1]).toEqual({ label: formatMonth('2025-04'), amount: 0 });
    expect(amounts(series).reduce((s, a) => s + a, 0)).toBe(160);
  });

  it('shows exactly twelve months for the last 12 months and starts in January for year to date', () => {
    const twelve = receivedSeries(received, '12m', 'month', TODAY);
    expect(twelve).toHaveLength(12);
    expect(twelve[0]).toEqual({ label: formatMonth('2025-11'), amount: 10 });
    expect(amounts(twelve).reduce((s, a) => s + a, 0)).toBe(60);
    const ytd = receivedSeries(received, 'ytd', 'month', TODAY);
    expect(ytd).toHaveLength(10);
    expect(ytd[0]).toEqual({ label: formatMonth('2026-01'), amount: 0 });
    expect(amounts(ytd).reduce((s, a) => s + a, 0)).toBe(50);
  });

  it('groups by quarter and by year', () => {
    const quarters = receivedSeries(received, '12m', 'quarter', TODAY);
    expect(quarters).toEqual([
      { label: 'Q4 25', amount: 10 },
      { label: 'Q1 26', amount: 25 },
      { label: 'Q2 26', amount: 15 },
      { label: 'Q3 26', amount: 7 },
      { label: 'Q4 26', amount: 3 },
    ]);
    expect(receivedSeries(received, 'all', 'year', TODAY)).toEqual([
      { label: '2025', amount: 110 },
      { label: '2026', amount: 50 },
    ]);
  });

  it('is a single empty bucket without payments', () => {
    expect(receivedSeries([], 'all', 'month', TODAY)).toEqual([{ label: formatMonth('2026-10'), amount: 0 }]);
  });
});

describe('receivedByHolding', () => {
  it('sums per symbol for the period, largest first', () => {
    expect(receivedByHolding(received, 'all', TODAY)).toEqual([
      { symbol: 'AAA', amount: 142 },
      { symbol: 'BBB', amount: 18 },
    ]);
    expect(receivedByHolding(received, 'ytd', TODAY)).toEqual([
      { symbol: 'AAA', amount: 42 },
      { symbol: 'BBB', amount: 8 },
    ]);
    expect(receivedByHolding([payment('2026-01-01', 5, 'ZZZ'), payment('2026-01-02', 5, 'AAA')], 'all', TODAY).map((t) => t.symbol)).toEqual(['AAA', 'ZZZ']);
    expect(receivedByHolding([], 'all', TODAY)).toEqual([]);
  });
});

describe('yearComparison', () => {
  const month = (m: string, total: number): AnalyticsDividendGrowthResponse['byMonth'][number] => ({ month: m, total, previousYearTotal: 0, yoyPct: null });

  it('puts the latest years side by side per calendar month', () => {
    const { years, rows } = yearComparison([month('2023-12', 1), month('2024-12', 2), month('2025-01', 3), month('2025-12', 4), month('2026-01', 5), month('2026-02', 6)]);
    expect(years).toEqual(['2024', '2025', '2026']);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ '2025': 3, '2026': 5 });
    expect(rows[0]!['2024']).toBeUndefined();
    expect(rows[1]).toMatchObject({ '2026': 6 });
    expect(rows[11]).toMatchObject({ '2024': 2, '2025': 4 });
    expect(rows[11]!['2026']).toBeUndefined();
    expect(rows[11]!['2023']).toBeUndefined();
  });

  it('is empty without months', () => {
    expect(yearComparison([]).years).toEqual([]);
  });
});
