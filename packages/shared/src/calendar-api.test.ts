import { describe, expect, it } from 'vitest';
import { CALENDAR_ROUTES, calendarQuerySchema, resolveCalendarQuery } from './calendar-api.js';

const parse = (q: Record<string, string>) => calendarQuerySchema.safeParse(q);
const resolve = (q: Record<string, string>, today = '2026-06-15') => resolveCalendarQuery(calendarQuerySchema.parse(q), today);

describe('calendar routes', () => {
  it('declares the JSON and the .ics endpoint', () => {
    expect(CALENDAR_ROUTES).toEqual({ calendar: 'GET /calendar', calendarIcs: 'GET /calendar.ics' });
  });
});

describe('calendarQuerySchema', () => {
  it('accepts an empty query and defaults the scope to all', () => {
    expect(parse({})).toMatchObject({ success: true, data: { scope: 'all' } });
    expect(parse({ from: '', to: '', types: '', status: '', scope: '', portfolioId: 'all' })).toMatchObject({ success: true, data: { scope: 'all', portfolioId: 'all' } });
  });

  it('parses comma-separated types and statuses case-insensitively', () => {
    const parsed = calendarQuerySchema.parse({ types: 'ex_dividend, earnings,', status: 'paid,CONFIRMED', scope: 'watchlist', portfolioId: 'p1' });
    expect(parsed.types).toEqual(['EX_DIVIDEND', 'EARNINGS']);
    expect(parsed.status).toEqual(['PAID', 'CONFIRMED']);
    expect(parsed.scope).toBe('watchlist');
    expect(parsed.portfolioId).toBe('p1');
  });

  it.each([
    [{ types: 'DIVIDEND' }],
    [{ status: 'maybe' }],
    [{ scope: 'everything' }],
    [{ from: '2026-13-01' }],
    [{ from: '2026-02-30' }],
    [{ to: '15-06-2026' }],
    [{ from: '2026-06-10', to: '2026-06-09' }],
    [{ portfolioId: 'bad id!' }],
  ])('rejects %j', (query) => {
    expect(parse(query).success).toBe(false);
  });

  it('allows ranges of up to 400 days (inclusive) and rejects longer ones', () => {
    expect(parse({ from: '2026-01-01', to: '2027-02-04' }).success).toBe(true);
    const tooLong = calendarQuerySchema.safeParse({ from: '2026-01-01', to: '2027-02-05' });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error?.issues[0]?.message).toBe('The range must not exceed 400 days');
    expect(calendarQuerySchema.safeParse({ from: '2026-02-01', to: '2026-01-01' }).error?.issues[0]?.message).toMatch(/not be before/);
  });
});

describe('resolveCalendarQuery', () => {
  it('defaults to the current month ± 1', () => {
    expect(resolve({})).toEqual({ from: '2026-05-01', to: '2026-07-31', scope: 'all', types: undefined, statuses: undefined });
  });
  it('keeps an explicit range, filters and scope', () => {
    expect(resolve({ from: '2026-01-05', to: '2026-02-10', types: 'SPLIT', status: 'CONFIRMED', scope: 'holdings' })).toEqual({
      from: '2026-01-05',
      to: '2026-02-10',
      scope: 'holdings',
      types: ['SPLIT'],
      statuses: ['CONFIRMED'],
    });
  });
  it('spans the following month when only `from` is given, and the preceding month when only `to` is', () => {
    expect(resolve({ from: '2026-11-20' })).toMatchObject({ from: '2026-11-20', to: '2026-12-31' });
    expect(resolve({ to: '2026-03-10' })).toMatchObject({ from: '2026-02-01', to: '2026-03-10' });
    expect(resolve({ from: '2026-12-02' })).toMatchObject({ to: '2027-01-31' });
  });
});
