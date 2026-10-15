import type { DividendGrowthStats, DividendPeriodGrowth } from '@portfolio/shared';
import { sp } from '../../test/utils';
import { cagrTile, growthTiles, quarterLabel, signedMoney, toneOf } from './growthStatsView';

const quarter = (pct: number | null, change: number, current: number, previous: number): DividendPeriodGrowth => ({
  basis: 'QUARTER',
  current: { from: '2026-07', to: '2026-09', amount: current },
  previous: { from: '2026-04', to: '2026-06', amount: previous },
  change,
  pct,
});

const stats = (over: Partial<DividendGrowthStats> = {}): DividendGrowthStats => ({ asOf: '2026-10-15', qoq: null, yoy: null, cagr: null, ...over });
const tiles = (s: DividendGrowthStats) => growthTiles(s, 'EUR').map((t) => ({ ...t, subtext: sp(t.subtext), amounts: t.amounts.map(sp), change: t.change && sp(t.change) }));

describe('helpers', () => {
  it('tones growth, treating tiny changes as flat', () => {
    expect([toneOf(null), toneOf(12.4), toneOf(-3), toneOf(0), toneOf(0.04), toneOf(-0.04), toneOf(0.05)]).toEqual(['none', 'gain', 'loss', 'flat', 'flat', 'flat', 'gain']);
  });

  it('signs euro amounts with a typographic minus', () => {
    expect([signedMoney(31.2, 'EUR'), signedMoney(-5, 'EUR'), signedMoney(0, 'EUR'), signedMoney(-0.001, 'EUR')].map(sp)).toEqual(['+€ 31,20', '−€ 5,00', '€ 0,00', '€ 0,00']);
  });

  it('labels the calendar quarter a month belongs to', () => {
    expect(['2026-01', '2026-03', '2026-04', '2026-07', '2025-10'].map(quarterLabel)).toEqual(['Q1 2026', 'Q1 2026', 'Q2 2026', 'Q3 2026', 'Q4 2025']);
  });
});

describe('growthTiles', () => {
  it('shows a rise with arrow, sign, change and the quarters compared', () => {
    const [qoq] = tiles(stats({ qoq: quarter(12.4, 31.2, 282.4, 251.2) }));
    expect(qoq).toMatchObject({ id: 'qoq', label: 'Quarter over quarter', value: '+12,4%', arrow: '▲', change: '+€ 31,20', tone: 'gain', subtext: 'Q3 2026 vs Q2 2026' });
    expect(qoq!.amounts).toEqual(['Q3 2026: € 282,40', 'Q2 2026: € 251,20']);
  });

  it('shows a fall with arrow and minus sign', () => {
    const [qoq] = tiles(stats({ qoq: quarter(-3.25, -8, 238, 246) }));
    expect(qoq).toMatchObject({ value: '−3,3%', arrow: '▼', change: '−€ 8,00', tone: 'loss' });
  });

  it('shows no arrow for flat growth', () => {
    const [qoq] = tiles(stats({ qoq: quarter(0.02, 0, 100, 100) }));
    expect(qoq).toMatchObject({ value: '0,0%', arrow: '', change: '€ 0,00', tone: 'flat' });
  });

  it('shows a dash with the reason when there is no baseline or no history', () => {
    const [qoq, yoy, cagr] = tiles(stats({ qoq: quarter(null, 42.5, 42.5, 0) }));
    expect(qoq).toMatchObject({ value: '—', arrow: '', change: null, tone: 'none', subtext: 'No dividends in Q2 2026 to compare with.' });
    expect(qoq!.amounts).toHaveLength(2);
    expect(yoy).toMatchObject({ value: '—', subtext: 'Needs at least 2 years of dividend history.', amounts: [] });
    expect(cagr).toMatchObject({ value: '—', subtext: 'Needs at least 2 complete calendar years of dividends.', amounts: [] });
    expect(tiles(stats())[0]!.subtext).toBe('Needs at least one complete quarter of dividends.');
  });

  it('states the 12-month and calendar-year periods of the year over year', () => {
    const ttm: DividendPeriodGrowth = { basis: 'TTM', current: { from: '2025-10', to: '2026-09', amount: 180 }, previous: { from: '2024-10', to: '2025-09', amount: 120 }, change: 60, pct: 50 };
    const [, yoy] = tiles(stats({ yoy: ttm }));
    expect(yoy).toMatchObject({ value: '+50,0%', change: '+€ 60,00' });
    expect(yoy!.subtext).toMatch(/^okt\.? 25 – sep\.? 26 vs okt\.? 24 – sep\.? 25$/);

    const years: DividendPeriodGrowth = { basis: 'CALENDAR_YEAR', current: { from: '2025-01', to: '2025-12', amount: 96 }, previous: { from: '2024-01', to: '2024-12', amount: 50 }, change: 46, pct: 92 };
    expect(tiles(stats({ yoy: years }))[1]).toMatchObject({ subtext: '2025 vs 2024 (calendar years)', amounts: ['2025: € 96,00', '2024: € 50,00'] });
  });

  it('describes the compound growth with start and end year and amounts', () => {
    const cagr = cagrTile({ startYear: 2023, endYear: 2025, startAmount: 120, endAmount: 310, years: 2, pct: 60.73 }, 'EUR');
    expect(cagr).toMatchObject({ id: 'cagr', label: 'All-time CAGR', value: '+60,7%', arrow: '▲', change: null, subtext: '2023 → 2025 · 2 years' });
    expect(cagr.amounts.map(sp)).toEqual(['2023 € 120,00 → 2025 € 310,00 over 2 years']);
    expect(cagrTile({ startYear: 2024, endYear: 2025, startAmount: 100, endAmount: 80, years: 1, pct: -20 }, 'EUR')).toMatchObject({ value: '−20,0%', arrow: '▼', subtext: '2024 → 2025 · 1 year' });
  });

  it('explains every figure', () => {
    for (const t of tiles(stats())) expect(t.method.join(' ')).toMatch(/complete|Net of withholding tax/);
  });
});
