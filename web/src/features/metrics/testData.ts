import type { AnalyticsMetricsResponse } from '@portfolio/shared';

/** A complete, healthy response (≈ the demo): everything present, benchmark with data but no P/E of its own. */
export function metricsFixture(over: Partial<AnalyticsMetricsResponse> = {}): AnalyticsMetricsResponse {
  return {
    baseCurrency: 'EUR',
    riskFreeRatePct: 2.5,
    benchmark: { symbol: 'IWDA.AS', available: true },
    twr: { portfolio: 38.1, benchmark: 45.9, difference: -7.8, from: '2025-06-02', to: '2026-10-15', days: 500, benchmarkFrom: '2025-06-02' },
    pe: {
      portfolio: 25.43,
      benchmark: null,
      coverage: { includedStocks: 4, totalStocks: 5, nonStockHoldings: 3, includedValue: 8300, stockValue: 10000, portfolioValue: 20000, portfolioSharePct: 41.5, stockSharePct: 83 },
      excluded: [{ symbol: 'JNJ', name: 'Johnson & Johnson', reason: 'missing', marketValue: 1700 }],
      asOf: '2026-10-06',
    },
    volatility: { portfolio: 12.3, benchmark: 15.1, beta: 0.679, verdict: { level: 'lower', label: 'lower than the market', tone: 'positive' }, observations: 330, benchmarkObservations: 330 },
    sharpe: { portfolio: 0.787, benchmark: 1.05, verdict: { level: 'attention', label: 'requires attention', tone: 'caution' }, observations: 330, benchmarkObservations: 330 },
    sortino: { portfolio: 1.31, benchmark: 2.4, verdict: { level: 'acceptable', label: 'acceptable', tone: 'neutral' }, observations: 330, benchmarkObservations: 330 },
    ...over,
  };
}
