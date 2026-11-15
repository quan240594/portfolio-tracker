import { describe, expect, it } from 'vitest';
import { FxTimeline } from './fx.js';
import { addIsoDays } from './analytics.js';
import { deriveRunRate, observedNetFactor, paymentsPerYear, splitSpecial, type RunRateInput } from './dividend-run-rate.js';
import type { DividendEvent, Transaction } from './types.js';

const TODAY = '2026-11-15';
const timeline = new FxTimeline({ base: 'EUR', rates: { USD: 1.25 }, asOf: TODAY });
const at = (offset: number) => addIsoDays(TODAY, offset);
const event = (offset: number, amount: number, currency = 'EUR'): DividendEvent => ({ symbol: 'X', exDate: at(offset), payDate: at(offset + 10), amount, currency });
const input = (over: Partial<RunRateInput>): RunRateInput => ({ currency: 'EUR', events: [], payments: [], timeline, today: TODAY, ...over });

describe('paymentsPerYear', () => {
  it('derives the frequency from the median gap and looks at the last five payments', () => {
    expect(paymentsPerYear([])).toBe(1);
    expect(paymentsPerYear(['2025-03-15'])).toBe(1);
    expect(paymentsPerYear(['2025-01-15', '2025-02-14', '2025-03-16'])).toBe(12);
    expect(paymentsPerYear(['2025-03-15', '2025-06-15', '2025-09-15'])).toBe(4);
    expect(paymentsPerYear(['2025-03-15', '2025-09-15'])).toBe(2);
    expect(paymentsPerYear(['2024-03-15', '2025-03-15'])).toBe(1);
    expect(paymentsPerYear(['2020-01-01', '2021-01-01', '2022-01-01', '2025-01-15', '2025-04-15', '2025-07-15', '2025-10-15'])).toBe(4);
  });
});

describe('splitSpecial', () => {
  const split = (amounts: number[]) => splitSpecial(amounts, (a) => a);

  it('flags a payment above 1.8 times the median of the (up to four) payments before it', () => {
    expect(split([1, 1, 1, 1.8])).toEqual({ regular: [1, 1, 1, 1.8], special: [] });
    expect(split([1, 1, 1, 1.81])).toEqual({ regular: [1, 1, 1], special: [1.81] });
    expect(split([1, 1, 1, 1, 1, 5, 1])).toEqual({ regular: [1, 1, 1, 1, 1, 1], special: [5] });
  });

  it('needs two payments before it can call one special, and accepts a lasting jump from the third payment on', () => {
    expect(split([1, 5]).special).toEqual([]);
    expect(split([1, 1, 5]).special).toEqual([5]);
    expect(split([1, 1, 1, 1, 2, 2, 2, 2]).special).toEqual([2, 2]);
  });
});

describe('deriveRunRate', () => {
  it('uses the provider history, with its frequency and its latest regular amount; a received payment of an event counts once', () => {
    const rate = deriveRunRate(input({ events: [event(-300, 1), event(-210, 1), event(-120, 1.1), event(-30, 1.2)], payments: [{ date: at(-18), perShare: 9 }] }));
    expect(rate).toMatchObject({ basis: 'provider-history', paymentsPerYear: 4, perShare: 1.2, lastPayDate: at(-20) });
  });

  it('completes thin provider history with the payments you received', () => {
    // the provider lists two events 18 months apart; your payments in between show it pays twice a year
    const events = [event(-560, 1), event(150, 1)];
    const payments = [{ date: at(-370), perShare: 1 }, { date: at(-190), perShare: 1 }, { date: at(-10), perShare: 1 }];
    expect(deriveRunRate(input({ events, payments }))).toMatchObject({ basis: 'own-payments', paymentsPerYear: 2, perShare: 1 });
    // the same events with no payments of yours: two events 18 months apart say once a year, the best the provider alone can tell
    expect(deriveRunRate(input({ events, payments: [] }))).toMatchObject({ basis: 'provider-history', paymentsPerYear: 1 });
  });

  it('matches a received payment to an event without a pay date up to 45 days after its ex-date', () => {
    const noPayDate = (offset: number): DividendEvent => ({ symbol: 'X', exDate: at(offset), amount: 1, currency: 'EUR' });
    const events = [noPayDate(-300), noPayDate(-210), noPayDate(-120), noPayDate(-30)];
    const payments = [-300, -210, -120, -30].map((d) => ({ date: at(d + 30), perShare: 1 }));
    expect(deriveRunRate(input({ events, payments }))).toMatchObject({ basis: 'provider-history', paymentsPerYear: 4 });
  });

  it('counts a declared upcoming event as the latest amount (a raise applies to the rest of the year)', () => {
    const rate = deriveRunRate(input({ events: [event(-210, 1), event(-120, 1), event(-30, 1), event(60, 1.2)] }));
    expect(rate).toMatchObject({ basis: 'provider-history', perShare: 1.2, lastPayDate: at(70) });
  });

  it('ignores events beyond a year ahead and events without an amount', () => {
    const rate = deriveRunRate(input({ events: [event(-120, 1), event(-30, 1), event(400, 5), event(-60, 0)] }));
    expect(rate).toMatchObject({ basis: 'provider-history', perShare: 1 });
  });

  it('converts a foreign dividend into the currency of the holding', () => {
    const rate = deriveRunRate(input({ currency: 'EUR', events: [event(-120, 1.25, 'USD'), event(-30, 1.25, 'USD')] }));
    expect(rate.perShare).toBeCloseTo(1, 10);
    const reverse = deriveRunRate(input({ currency: 'USD', events: [event(-120, 1, 'EUR'), event(-30, 1, 'EUR')] }));
    expect(reverse.perShare).toBeCloseTo(1.25, 10);
  });

  it('falls back to the owner\'s payments without provider history, then to one payment, then to nothing', () => {
    const own = [-200, -110, -20].map((d) => ({ date: at(d), perShare: 0.5 }));
    expect(deriveRunRate(input({ payments: own }))).toMatchObject({ basis: 'own-payments', paymentsPerYear: 4, perShare: 0.5, lastPayDate: at(-20) });
    expect(deriveRunRate(input({ payments: own.slice(-1) }))).toMatchObject({ basis: 'single-payment-assumed', paymentsPerYear: 1 });
    expect(deriveRunRate(input({ events: [event(-30, 2)] }))).toMatchObject({ basis: 'single-payment-assumed', perShare: 2 });
    expect(deriveRunRate(input({}))).toMatchObject({ basis: 'none', perShare: 0, lastPayDate: null });
  });

  it('treats a payer without a regular payment for more than a year (and a month) as stopped', () => {
    const stale = deriveRunRate(input({ events: [event(-500, 1), event(-410, 1)] }));
    expect(stale.basis).toBe('none');
    expect(deriveRunRate(input({ events: [event(-500, 1)] })).basis).toBe('none');
    expect(deriveRunRate(input({ payments: [{ date: at(-420), perShare: 1 }, { date: at(-410), perShare: 1 }] })).basis).toBe('none');
    expect(deriveRunRate(input({ events: [event(-390, 1), event(-30, 1)] })).basis).toBe('provider-history');
  });

  it('reports the special ex-dates and keeps them out of the amount', () => {
    const rate = deriveRunRate(input({ events: [event(-300, 1), event(-210, 1), event(-120, 1), event(-30, 5)] }));
    expect(rate).toMatchObject({ basis: 'provider-history', perShare: 1 });
    expect([...rate.specialExDates]).toEqual([at(-30)]);
  });
});

describe('observedNetFactor', () => {
  const dividend = (symbol: string, currency: string, gross: number, withheld: number): Transaction => ({
    id: `${symbol}${gross}`,
    userId: 'u',
    portfolioId: 'default',
    date: at(-30),
    type: 'DIVIDEND',
    symbol,
    quantity: 1,
    price: gross,
    fee: withheld,
    currency,
    createdAt: `${at(-30)}T00:00:00Z`,
  });

  it('takes the symbol\'s own rate, else the rate of the payers in the same currency, else nothing withheld', () => {
    const trailing = [dividend('A', 'USD', 100, 15), dividend('B', 'USD', 100, 15), dividend('C', 'EUR', 100, 0), dividend('D', 'EUR', 100, 25)];
    expect(observedNetFactor(trailing, 'D', 'EUR')).toBe(0.75);
    expect(observedNetFactor(trailing, 'NEW', 'USD')).toBe(0.85);
    expect(observedNetFactor(trailing, 'NEW', 'EUR')).toBe(0.875);
    expect(observedNetFactor(trailing, 'NEW', 'GBP')).toBe(1);
    expect(observedNetFactor([], 'A', 'USD')).toBe(1);
  });

  it('never goes below zero', () => {
    expect(observedNetFactor([dividend('A', 'USD', 10, 20)], 'A', 'USD')).toBe(0);
  });
});
