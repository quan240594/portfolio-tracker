import type { AssetHistoryResponse } from '@portfolio/shared';
import { sp } from '../../test/utils';
import {
  availableBenchmarks,
  benchKey,
  chartExtremes,
  chartRows,
  chartSummary,
  chartTableRows,
  chartTooltip,
  formatChartValue,
  labelPosition,
  plottedMarkers,
} from './assetChartData';

const history = (over: Partial<AssetHistoryResponse> = {}): AssetHistoryResponse => ({
  symbol: 'AAA',
  range: '1M',
  baseCurrency: 'EUR',
  currency: 'USD',
  points: [
    { date: '2026-06-01', close: 100, pct: 0 },
    { date: '2026-06-02', close: 90, pct: -10 },
    { date: '2026-06-03', close: 120, pct: 20 },
  ],
  benchmarks: [
    { symbol: 'IWDA.AS', available: true, points: [{ value: 50, returnPct: 0 }, { value: null, returnPct: null }, { value: 55, returnPct: 10 }], comparison: null },
    { symbol: 'XXX', available: false, message: 'none', points: [], comparison: null },
  ],
  options: [],
  markers: [
    { date: '2026-06-02', plotDate: '2026-06-02', type: 'BUY', portfolioId: 'default', quantity: 1, price: 90, amountBase: 70 },
    { date: '2026-06-09', plotDate: '2026-06-09', type: 'SELL', portfolioId: 'default', quantity: 1, price: 90, amountBase: 70 },
  ],
  coverage: { from: '2026-06-01', to: '2026-06-03', limited: false },
  ...over,
});

describe('assetChartData', () => {
  it('lists the benchmarks that have data with their response index', () => {
    expect(availableBenchmarks(history())).toEqual([{ symbol: 'IWDA.AS', index: 0 }]);
    expect(benchKey(2)).toBe('b2');
  });

  it('builds performance rows with benchmark columns and price rows without', () => {
    expect(chartRows(history(), 'performance')).toEqual([
      { date: '2026-06-01', value: 0, b0: 0 },
      { date: '2026-06-02', value: -10, b0: null },
      { date: '2026-06-03', value: 20, b0: 10 },
    ]);
    expect(chartRows(history(), 'price').map((r) => r.value)).toEqual([100, 90, 120]);
    expect(chartRows(history(), 'price')[0]).toEqual({ date: '2026-06-01', value: 100 });
  });

  it('treats a benchmark shorter than the series as null', () => {
    const rows = chartRows(history({ benchmarks: [{ symbol: 'B', available: true, points: [{ value: 1, returnPct: 0 }], comparison: null }] }), 'performance');
    expect(rows.map((r) => r.b0)).toEqual([0, null, null]);
  });

  it('keeps only markers that fall on a plotted row', () => {
    const rows = chartRows(history(), 'price');
    const markers = plottedMarkers(history(), rows);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ type: 'BUY', x: '2026-06-02', y: 90 });
    expect(markers[0]!.label).toMatch(/^Buy 2 jun 2026$/);
  });

  it('finds the extremes of the line', () => {
    expect(chartExtremes(chartRows(history(), 'price'))).toEqual({ min: { date: '2026-06-02', value: 90 }, max: { date: '2026-06-03', value: 120 } });
    expect(chartExtremes([])).toEqual({ min: null, max: null });
  });

  it('puts min/max labels beside the dot near the plot edges', () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ date: `d${i}`, value: i }));
    expect(labelPosition(rows, 'd5', 'top')).toBe('top');
    expect(labelPosition(rows, 'd5', 'bottom')).toBe('bottom');
    expect(labelPosition(rows, 'd10', 'top')).toBe('left');
    expect(labelPosition(rows, 'd0', 'bottom')).toBe('right');
    expect(labelPosition([{ date: 'x', value: 1 }], 'x', 'top')).toBe('top');
  });

  it('formats values per mode', () => {
    expect(sp(formatChartValue('price', 'USD')(1234.5))).toBe('US$ 1.234,50');
    expect(sp(formatChartValue('price', 'EUR')(0.123456))).toBe('€ 0,123456');
    expect(formatChartValue('performance', 'USD')(12.345)).toBe('+12,35%');
    expect(chartTooltip('performance', 'USD')(5, 'AAA')).toEqual(['+5,00%', 'AAA']);
  });

  it('describes the chart in words', () => {
    expect(chartSummary(history(), 'performance')).toBe('Price change of AAA from 1 jun 2026 to 3 jun 2026: +20,00%.');
    expect(sp(chartSummary(history(), 'price'))).toBe('Closing price of AAA from 1 jun 2026 to 3 jun 2026: US$ 100,00 to US$ 120,00 (+20,00%).');
    expect(chartSummary(history({ points: [] }), 'price')).toBe('No price history is stored for AAA in this period.');
  });

  it('builds sampled data-table rows for both modes', () => {
    const perf = chartTableRows(history(), 'performance', 24);
    expect(perf.columns).toEqual(['Date', 'AAA', 'IWDA.AS']);
    expect(perf.rows).toEqual([
      ['1 jun 2026', '0,00%', '0,00%'],
      ['2 jun 2026', '−10,00%', '—'],
      ['3 jun 2026', '+20,00%', '+10,00%'],
    ]);
    const price = chartTableRows(history(), 'price', 2);
    expect(price.columns).toEqual(['Date', 'Close', 'Change']);
    expect(price.rows).toHaveLength(2);
    expect(sp(price.rows[1]!.join('|'))).toBe('3 jun 2026|US$ 120,00|+20,00%');
    const short = chartTableRows(history({ benchmarks: [{ symbol: 'B', available: true, points: [], comparison: null }] }), 'performance', 24);
    expect(short.rows[2]).toEqual(['3 jun 2026', '+20,00%', '—']);
  });
});
