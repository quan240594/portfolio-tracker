import type { GetValuationReportResponse, ValuationDay, ValuationLine } from '@portfolio/shared';

export const valuationLine = (over: Partial<ValuationLine> = {}): ValuationLine => ({
  symbol: 'AAPL',
  units: 10,
  currency: 'USD',
  price: 200,
  priceCurrency: 'USD',
  priceDate: '2026-10-24',
  ageDays: 0,
  source: 'close',
  fxRate: 1.1,
  fxDate: '2026-10-23',
  fxFallback: 'none',
  value: 1818.18,
  fair: 1818.18,
  gap: 0,
  today: 1900,
  flags: [],
  ...over,
});

export const valuationDay = (date: string, lines: ValuationLine[], over: Partial<ValuationDay> = {}): ValuationDay => ({
  date,
  chartValue: 57000,
  positionsValue: 57000,
  extraValue: 0,
  invested: 56000,
  fairValue: 64500,
  gap: -7500,
  lines,
  ...over,
});

/** The pattern of the owner's chart: a fund valued at cost, a USD London line taken for pence, an old close and a euro line that is fine. */
export const VALUATION_LINES: ValuationLine[] = [
  valuationLine({ symbol: 'IITU.L', units: 140, price: 52, value: 6618.18, fair: 66.18, gap: 6552, flags: ['scale'], today: 6700 }),
  valuationLine({ symbol: 'FWRA.MI', units: 1000, currency: 'EUR', price: 9.5, priceCurrency: 'EUR', priceDate: null, ageDays: null, source: 'cost', fxRate: 1, fxDate: null, value: 9500, fair: 11200, gap: -1700, flags: ['cost'], today: 11200 }),
  valuationLine({ symbol: 'ADB.DE', units: 20, currency: 'EUR', price: 41.5, priceCurrency: 'EUR', priceDate: '2026-10-19', ageDays: 6, source: 'carried', fxRate: 1, fxDate: null, value: 830, fair: 830, gap: 0, flags: ['carried', 'stale'], today: 840 }),
  valuationLine({ symbol: 'AMZN', units: 5, price: 220.5, fxFallback: 'before', fxDate: '2026-02-02', value: 1002.27, fair: 1002.27, gap: 0, flags: ['fx'], today: null }),
];

export const valuationReport = (over: Partial<GetValuationReportResponse> = {}): GetValuationReportResponse => ({
  asOf: '2026-10-25T00:00:00.000Z',
  baseCurrency: 'EUR',
  headline: 64012.5,
  days: [
    valuationDay('2026-04-25', [valuationLine({ symbol: 'AAPL' })], { chartValue: 33000, positionsValue: 33000, invested: 40000, fairValue: 36000, gap: -3000 }),
    valuationDay('2026-10-24', VALUATION_LINES),
    valuationDay('2026-10-25', VALUATION_LINES, { chartValue: 64012.5, positionsValue: 63012.5, extraValue: 1000, invested: 55010, fairValue: 64000, gap: -987.5 }),
  ],
  fx: [
    { currency: 'GBP', fixings: 0, first: null, last: null, fallbackDays: 1 },
    { currency: 'USD', fixings: 134, first: '2026-02-02', last: '2026-10-23', fallbackDays: 383 },
  ],
  symbolsTotal: 4,
  truncated: false,
  rowsRead: 6620,
  ...over,
});
