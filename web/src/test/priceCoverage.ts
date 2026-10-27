import type { HeldSymbolCoverage, PriceHistoryCoverage } from '@portfolio/shared';

export const symbolRow = (over: Partial<HeldSymbolCoverage> = {}): HeldSymbolCoverage => ({
  symbol: 'ASML.AS',
  name: 'ASML Holding',
  provider: 'eodhd',
  eodRows: 252,
  eodRowsCapped: false,
  firstEod: '2025-10-23',
  lastEod: '2026-10-23',
  eodSources: ['eodhd'],
  proxyListing: null,
  historyOverride: null,
  firstTransaction: '2024-03-02',
  lastQuoteAt: '2026-10-23T08:15:00.000Z',
  lastQuoteSource: 't212',
  historyState: 'complete',
  lastAttempt: null,
  reason: 'Full history stored',
  ...over,
});

/** One missing, one partial and one complete symbol: what the owner's deployment looked like before the snapshot rows. */
export const coverage = (over: Partial<PriceHistoryCoverage> = {}): PriceHistoryCoverage => ({
  asOf: '2026-10-23T09:00:00.000Z',
  symbols: [
    symbolRow({
      symbol: 'NOVO-B.CO',
      name: 'Novo Nordisk',
      eodRows: 0,
      firstEod: null,
      lastEod: null,
      eodSources: [],
      firstTransaction: '2026-01-05',
      lastQuoteAt: null,
      lastQuoteSource: null,
      historyState: 'missing',
      reason: 'No provider key for this exchange',
    }),
    symbolRow({
      symbol: 'MSFT',
      name: 'Microsoft',
      provider: 'twelvedata',
      eodRows: 40,
      firstEod: '2026-09-01',
      lastEod: '2026-10-23',
      eodSources: ['provider', 't212'],
      firstTransaction: '2026-03-02',
      historyState: 'partial',
      lastAttempt: { day: '2026-10-22', attempts: 2, outcome: 'retry', error: 'Daily credits exhausted' },
      reason: 'Daily quota used up, retries after reset',
    }),
    symbolRow(),
  ],
  totals: { held: 3, complete: 1, partial: 1, missing: 1, valuedAtCostSince: '2026-01-05', valuedAtCostUntil: '2026-10-23', truncated: false },
  rowsRead: 330,
  ...over,
});

/** The body of `GET /prices/status` around a coverage report. */
export const pricesStatus = (history: PriceHistoryCoverage | null = coverage()) => ({
  state: 'partial',
  sources: [],
  missingSecrets: [],
  message: 'Some market-data API keys are not set.',
  t212Quotes: null,
  history,
});
