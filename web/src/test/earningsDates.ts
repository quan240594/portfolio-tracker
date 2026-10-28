import type { EarningsRunReport, GetEarningsDatesResponse, HeldEarningsDate } from '@portfolio/shared';

export const earningsRun = (over: Partial<EarningsRunReport> = {}): EarningsRunReport => ({
  at: '2026-10-28T04:30:00.000Z',
  trigger: 'scheduled',
  status: 'ok',
  reason: '',
  tracked: 6,
  rows: 5120,
  events: 3,
  matchedHeld: 3,
  ...over,
});

export const heldDate = (over: Partial<HeldEarningsDate> = {}): HeldEarningsDate => ({
  symbol: 'GOOGL',
  name: 'Alphabet Inc',
  next: { date: '2026-10-28', source: 'scheduled', timeOfDay: 'AMC' },
  reasonCode: null,
  reason: null,
  ...over,
});

/** One company without a date (not in the provider's calendar) and two with one. */
export const earningsDates = (over: Partial<GetEarningsDatesResponse> = {}): GetEarningsDatesResponse => ({
  asOf: '2026-10-28T09:00:00.000Z',
  today: '2026-10-28',
  lastRun: earningsRun(),
  lastSuccess: earningsRun(),
  budget: { provider: 'Alpha Vantage', day: '2026-10-28', used: 4, limit: 25, remaining: 21, calendarUsed: 1, calendarLimit: 1 },
  refresh: { available: true, reason: null, nextAllowedAt: null },
  held: 3,
  withDate: 2,
  symbols: [
    heldDate({ symbol: 'NOVO-B.CO', name: 'Novo Nordisk', next: null, reasonCode: 'not-listed', reason: "Not in the provider's calendar: its calendar of 5120 rows (2026-10-28) has no row for NOVO-B.CO." }),
    heldDate(),
    heldDate({ symbol: 'ASML.AS', name: 'ASML Holding', next: { date: '2027-01-28', source: 'projected', timeOfDay: 'unknown' } }),
  ],
  ...over,
});
