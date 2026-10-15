import { computeDividendGrowth, type AnalyticsData } from '@portfolio/shared';
import { createSeed } from './fixtures';

/** The demo is relative to "today"; these dates pin it so the figures the e2e tests assert are reproducible. */
const demoAt = (iso: string) => {
  const s = createSeed(new Date(`${iso}T10:00:00Z`));
  return computeDividendGrowth({ transactions: s.transactions, fx: s.fx, fxHistory: s.fxHistory, today: s.today } as unknown as AnalyticsData);
};

describe('demo dividend history', () => {
  it('reaches back over three years so every growth figure can be shown', () => {
    const g = demoAt('2026-10-15');
    expect(g.byYear.map((y) => y.year)).toEqual(['2023', '2024', '2025', '2026']);
    expect(g.growthStats).toEqual({
      asOf: '2026-10-15',
      // Q3 2026 = Jul 35,64 + Aug 27,97 + Sep 67,90; Q2 2026 = Apr 0 + May 28,81 + Jun 50,67
      qoq: { basis: 'QUARTER', current: { from: '2026-07', to: '2026-09', amount: 131.51 }, previous: { from: '2026-04', to: '2026-06', amount: 79.48 }, change: 52.03, pct: 65.46 },
      yoy: { basis: 'TTM', current: { from: '2025-10', to: '2026-09', amount: 413.58 }, previous: { from: '2024-10', to: '2025-09', amount: 354.52 }, change: 59.06, pct: 16.66 },
      cagr: { startYear: 2023, endYear: 2025, startAmount: 95.81, endAmount: 353.31, years: 2, pct: 92.03 },
    });
  });

  it('shows all three figures on any day of the year', () => {
    for (const day of ['2026-01-01', '2026-02-28', '2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31', '2028-02-29']) {
      const stats = demoAt(day).growthStats!;
      expect([day, stats.qoq?.pct !== null, stats.yoy?.pct !== null, stats.cagr !== null]).toEqual([day, true, true, true]);
    }
  });
});
