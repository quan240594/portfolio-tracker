import type { GetDividendDatesResponse, HeldDividendDate } from '@portfolio/shared';

export const NO_CHECK = { checkedAt: null, attemptAt: null, outcome: null, reason: '', source: null, events: null } as const;

export const heldDividend = (over: Partial<HeldDividendDate> = {}): HeldDividendDate => ({
  symbol: 'HESM',
  name: 'Hess Midstream LP',
  boughtOn: '2025-01-02',
  next: { exDate: '2026-11-05', payDate: '2026-11-13', amount: 0.7152, currency: 'USD', source: 'eodhd', kind: 'declared', enteredByYou: false },
  last: { exDate: '2026-11-05', payDate: '2026-11-13', amount: 0.7152, currency: 'USD', source: 'eodhd', kind: 'declared', enteredByYou: false },
  check: { checkedAt: '2026-11-05T05:30:00.000Z', attemptAt: '2026-11-05T05:30:00.000Z', outcome: 'ok', reason: '', source: 'eodhd', events: 3 },
  reasonCode: null,
  reason: null,
  ...over,
});

/** One symbol without a declared date (EODHD lists nothing yet), one that is only projected, and one with an ex-date today. */
export const dividendDates = (over: Partial<GetDividendDatesResponse> = {}): GetDividendDatesResponse => ({
  asOf: '2026-11-05T09:00:00.000Z',
  today: '2026-11-05',
  budget: { provider: 'EODHD', day: '2026-11-05', used: 6, limit: 20, remaining: 14, calendarUsed: 2, calendarLimit: 8 },
  refresh: { available: true, reason: null, nextAllowedAt: null },
  feed: { source: 'Alpha Vantage', status: 'untested', at: null, retryAt: null, reason: 'The first fallback call has not been made yet.' },
  configured: { eodhd: true, alphavantage: true },
  held: 3,
  withDeclared: 1,
  symbols: [
    heldDividend({
      symbol: 'KO',
      name: 'The Coca-Cola Company',
      next: null,
      last: { exDate: '2026-09-15', payDate: '2026-10-01', amount: 0.51, currency: 'USD', source: 'eodhd', kind: 'declared', enteredByYou: false },
      check: { checkedAt: '2026-10-30T05:30:00.000Z', attemptAt: '2026-11-05T05:30:00.000Z', outcome: 'budget', reason: '', source: 'eodhd', events: 0 },
      reasonCode: 'budget',
      reason: 'Skipped on 2026-11-05: the day’s allowance for the calendar was used up before its turn. Last read successfully on 2026-10-30.',
    }),
    heldDividend({
      symbol: 'VWRL.AS',
      name: 'Vanguard FTSE All-World',
      next: { exDate: '2026-12-18', payDate: '2027-01-05', amount: null, currency: 'EUR', source: 'history', kind: 'estimated', enteredByYou: false },
      last: null,
      check: NO_CHECK,
      reasonCode: 'estimate-only',
      reason: 'Only a projection from your payment history: no declared dividend is stored.',
    }),
    heldDividend(),
  ],
  ...over,
});
