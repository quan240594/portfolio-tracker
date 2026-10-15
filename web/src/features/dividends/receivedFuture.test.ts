import type { DividendPayment, FutureHoldingAmount, FutureMonth } from '@portfolio/shared';
import {
  averageReceived,
  chartRows,
  labelStep,
  niceAxis,
  periodText,
  receivedFutureTimeline,
  timelineTotals,
  upcomingBand,
  type FutureIncome,
  type TimelinePeriod,
} from './receivedFuture';

const TODAY = '2026-10-15';
const payment = (date: string, amount: number, symbol = 'AAA'): DividendPayment => ({ symbol, date, perShareLocal: 1, currency: 'EUR', amount, status: 'RECEIVED' });
const received = [
  payment('2025-11-20', 10, 'BBB'),
  payment('2026-02-10', 20),
  payment('2026-03-05', 5, 'BBB'),
  payment('2026-09-30', 7),
  payment('2026-10-10', 3, 'BBB'),
  payment('2026-12-01', 999), // not paid yet
];
const monthKeys = ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09'];
const months: FutureMonth[] = monthKeys.map((month) => ({ month, declared: 0, estimated: 0 }));
const setMonth = (month: string, declared: number, estimated: number) => {
  const m = months.find((x) => x.month === month)!;
  m.declared = declared;
  m.estimated = estimated;
};
setMonth('2026-10', 4.5, 0);
setMonth('2026-12', 30, 10);
setMonth('2027-03', 0, 6.8);
setMonth('2027-09', 12, 0);
const byHolding: FutureHoldingAmount[] = [
  { month: '2026-10', symbol: 'AAA', declared: 4.5, estimated: 0 },
  { month: '2026-12', symbol: 'AAA', declared: 20, estimated: 10 },
  { month: '2026-12', symbol: 'CCC', declared: 10, estimated: 0 },
  { month: '2027-03', symbol: 'BBB', declared: 0, estimated: 6.8 },
  { month: '2027-09', symbol: 'AAA', declared: 12, estimated: 0 },
];
const future: FutureIncome = { months, byHolding };
const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);

describe('receivedFutureTimeline', () => {
  it('is the received history alone without future income', () => {
    const periods = receivedFutureTimeline(received, '12m', 'month', TODAY);
    expect(periods).toHaveLength(12);
    expect(periods.map((p) => p.phase)).toEqual([...Array<string>(11).fill('past'), 'current']);
    expect(periods.every((p) => p.declared === 0 && p.estimated === 0 && p.total === p.paid)).toBe(true);
    expect(periods.at(-1)).toMatchObject({ paid: 3, total: 3, holdings: [{ symbol: 'BBB', amount: 3 }] });
    expect(timelineTotals(periods)).toEqual({ paid: 45, declared: 0, estimated: 0 });
  });

  it('appends the upcoming 12 months and stacks the current month: received so far + still expected', () => {
    const periods = receivedFutureTimeline(received, '12m', 'month', TODAY, future);
    expect(periods).toHaveLength(23);
    const current = periods.find((p) => p.phase === 'current')!;
    expect(current).toMatchObject({ paid: 3, declared: 4.5, estimated: 0, total: 7.5 });
    expect(current.holdings).toEqual([
      { symbol: 'AAA', amount: 4.5 },
      { symbol: 'BBB', amount: 3 },
    ]);
    const upcoming = periods.filter((p) => p.phase === 'upcoming');
    expect(upcoming).toHaveLength(11);
    expect(upcoming[1]).toMatchObject({ paid: 0, declared: 30, estimated: 10, total: 40 });
    expect(upcoming[1]!.holdings).toEqual([
      { symbol: 'AAA', amount: 30 },
      { symbol: 'CCC', amount: 10 },
    ]);
    // the future periods reconcile with the overview (forward 12 months = declared + estimated)
    expect(sum(periods.map((p) => p.declared + p.estimated))).toBeCloseTo(sum(months.map((m) => m.declared + m.estimated)), 2);
  });

  it('sums the future months into quarters and years', () => {
    const quarters = receivedFutureTimeline(received, '12m', 'quarter', TODAY, future);
    expect(quarters.map((p) => [p.label, p.phase, p.total])).toEqual([
      ['Q4 25', 'past', 10],
      ['Q1 26', 'past', 25],
      ['Q2 26', 'past', 0],
      ['Q3 26', 'past', 7],
      ['Q4 26', 'current', 3 + 4.5 + 40],
      ['Q1 27', 'upcoming', 6.8],
      ['Q2 27', 'upcoming', 0],
      ['Q3 27', 'upcoming', 12],
    ]);
    const years = receivedFutureTimeline(received, 'all', 'year', TODAY, future);
    expect(years.map((p) => [p.label, p.phase, p.paid, p.declared, p.estimated])).toEqual([
      ['2025', 'past', 10, 0, 0],
      ['2026', 'current', 35, 34.5, 10],
      ['2027', 'upcoming', 0, 12, 6.8],
    ]);
    expect(years[1]!.holdings).toEqual([
      { symbol: 'AAA', amount: 61.5 }, // 27 received + 34.5 expected
      { symbol: 'CCC', amount: 10 },
      { symbol: 'BBB', amount: 8 },
    ]);
  });

  it('hides the breakdown of future periods when the overview has no per-holding amounts', () => {
    const periods = receivedFutureTimeline(received, '12m', 'month', TODAY, { months });
    expect(periods.find((p) => p.phase === 'current')!.holdings).toEqual([]);
    expect(periods.filter((p) => p.total > 0 && p.declared + p.estimated > 0).every((p) => p.holdings.length === 0)).toBe(true);
    // received-only periods keep theirs
    expect(periods[0]!.holdings).toEqual([{ symbol: 'BBB', amount: 10 }]);
  });

  it('fills gaps and aligns future months that start after the current period', () => {
    const later: FutureIncome = { months: [{ month: '2027-02', declared: 5, estimated: 0 }] };
    const periods = receivedFutureTimeline([payment('2026-09-01', 1)], 'all', 'month', TODAY, later);
    expect(periods.map((p) => p.label)).toHaveLength(6);
    expect(periods.map((p) => p.phase)).toEqual(['past', 'current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(periods.at(-1)).toMatchObject({ declared: 5, total: 5 });
  });

  it('is a single empty current period without any data', () => {
    expect(receivedFutureTimeline([], 'all', 'month', TODAY)).toMatchObject([{ phase: 'current', paid: 0, total: 0, holdings: [] }]);
  });
});

describe('averageReceived', () => {
  it('averages what was received per completed period, leaving out the current and upcoming ones', () => {
    const periods = receivedFutureTimeline(received, '12m', 'quarter', TODAY, future);
    expect(averageReceived(periods)).toBe(10.5); // (10 + 25 + 0 + 7) / 4
    expect(averageReceived(receivedFutureTimeline(received, 'all', 'year', TODAY, future))).toBe(10);
  });

  it('is null without a completed period or without income in them', () => {
    expect(averageReceived(receivedFutureTimeline(received, 'ytd', 'year', TODAY, future))).toBeNull();
    expect(averageReceived(receivedFutureTimeline([payment('2026-10-01', 4)], 'all', 'month', TODAY))).toBeNull();
    expect(averageReceived(receivedFutureTimeline([payment('2026-08-01', 0)], 'all', 'month', TODAY))).toBeNull();
  });
});

describe('upcomingBand and timelineTotals', () => {
  it('spans the periods that lie completely in the future', () => {
    const periods = receivedFutureTimeline(received, 'ytd', 'month', TODAY, future);
    expect(upcomingBand(periods)).toEqual({ from: periods[10]!.label, to: periods.at(-1)!.label });
    expect(upcomingBand(receivedFutureTimeline(received, 'ytd', 'month', TODAY))).toBeNull();
    // the future fits in the current year: no period is only in the future
    expect(upcomingBand(receivedFutureTimeline(received, 'ytd', 'year', '2026-01-15', { months: [{ month: '2026-01', declared: 1, estimated: 0 }] }))).toBeNull();
  });

  it('adds up the three amounts', () => {
    expect(timelineTotals(receivedFutureTimeline(received, 'all', 'year', TODAY, future))).toEqual({ paid: 45, declared: 46.5, estimated: 16.8 });
  });
});

describe('value labels', () => {
  const period = (total: number): TimelinePeriod => ({ key: 1, label: 'x', phase: 'past', paid: total, declared: 0, estimated: 0, total, holdings: [] });

  it('steps over bars only when a label is wider than its slot', () => {
    expect(labelStep(['€ 54', '€ 1,2K'], 44)).toBe(1);
    expect(labelStep(['€ 123,4K'], 44)).toBe(2);
    expect(labelStep(['€ 123,4K'], 20)).toBe(3);
    expect(labelStep([], 44)).toBe(1);
  });

  it('labels every bar with its compact total and leaves zero bars empty', () => {
    const rows = chartRows([period(54), period(0), period(1234), period(0.3)], 'EUR', 44);
    expect(rows.map((r) => r.barLabel.replaceAll(/\s/g, ' '))).toEqual(['€ 54', '', '€ 1,2K', '']);
  });

  it('keeps every other label on a narrow slot', () => {
    const rows = chartRows([period(123456), period(2), period(123456), period(2)], 'EUR', 30);
    expect(rows.map((r) => r.barLabel === '')).toEqual([false, true, false, true]);
  });
});

describe('periodText', () => {
  it('names the phase in words only for the periods that are not past', () => {
    expect(periodText({ label: 'Q4 26', phase: 'current' }, true)).toBe('Q4 26 · Current');
    expect(periodText({ label: 'Q1 27', phase: 'upcoming' }, true)).toBe('Q1 27 · Upcoming');
    expect(periodText({ label: 'Q3 26', phase: 'past' }, true)).toBe('Q3 26');
    expect(periodText({ label: 'Q1 27', phase: 'upcoming' }, false)).toBe('Q1 27');
  });
});

describe('niceAxis', () => {
  it('rounds the maximum up to a step of 1, 2 or 5 × 10ⁿ with evenly spaced ticks', () => {
    expect(niceAxis(79)).toEqual({ max: 80, ticks: [0, 20, 40, 60, 80] });
    expect(niceAxis(450)).toEqual({ max: 600, ticks: [0, 200, 400, 600] });
    expect(niceAxis(7.5)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceAxis(100)).toEqual({ max: 100, ticks: [0, 50, 100] });
  });

  it('falls back to 0-1 without a positive maximum', () => {
    expect(niceAxis(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceAxis(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] });
  });
});
