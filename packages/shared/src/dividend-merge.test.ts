import { describe, expect, it } from 'vitest';
import { MANUAL_DIVIDEND_SOURCE, mergeDividendEvent, mergeDividendEvents, withManualDividends } from './dividend-merge.js';
import type { DividendEvent } from './types.js';

const ev = (extra: Partial<DividendEvent> = {}): DividendEvent => ({ symbol: 'HESM', exDate: '2026-11-05', amount: 0.7, currency: 'USD', ...extra });
const manual = (extra: Partial<DividendEvent> = {}): DividendEvent => ev({ source: MANUAL_DIVIDEND_SOURCE, declared: true, ...extra });

describe('mergeDividendEvent', () => {
  it('keeps the incoming record when nothing is stored', () => {
    expect(mergeDividendEvent(undefined, ev())).toEqual(ev());
  });

  it('lets a provider record with an amount replace an entry of the owner, keeping the owner pay date it lacks', () => {
    const merged = mergeDividendEvent(manual({ payDate: '2026-11-13', amount: 0 }), ev({ source: 'eodhd' }));
    expect(merged).toEqual(ev({ source: 'eodhd', payDate: '2026-11-13', declared: true }));
  });

  it('keeps the entry of the owner when the provider record has no amount', () => {
    const own = manual();
    expect(mergeDividendEvent(own, ev({ source: 'eodhd', amount: 0 }))).toBe(own);
  });

  it('lets an entry of the owner replace an amountless provider record only', () => {
    const own = manual({ payDate: '2026-11-13' });
    expect(mergeDividendEvent(ev({ source: 'eodhd', amount: 0 }), own)).toBe(own);
    expect(mergeDividendEvent(ev({ source: 'eodhd' }), own)).toEqual(ev({ source: 'eodhd', payDate: '2026-11-13', declared: true }));
  });

  it('prefers the record with a pay date between providers and keeps what only the other knows', () => {
    const withPay = ev({ source: 'alphavantage', payDate: '2026-11-13', declared: true, declarationDate: '2026-10-21', amount: 0.71 });
    const bare = ev({ source: 'eodhd' });
    expect(mergeDividendEvent(withPay, bare)).toEqual(withPay);
    expect(mergeDividendEvent(bare, withPay)).toEqual(withPay);
  });

  it('takes the newer record when both are equally complete and keeps the declaration date only the older one has', () => {
    const older = ev({ source: 'eodhd', payDate: '2026-11-13', declarationDate: '2026-10-21' });
    const newer = ev({ source: 'alphavantage', payDate: '2026-11-14', amount: 0.72 });
    expect(mergeDividendEvent(older, newer)).toEqual({ ...newer, declarationDate: '2026-10-21' });
  });

  it('lets a newer record of the same source correct the amount and keeps the pay date it lacks', () => {
    const older = ev({ source: 'eodhd', payDate: '2026-11-13', declared: true });
    expect(mergeDividendEvent(older, ev({ source: 'eodhd', amount: 0.71 }))).toEqual({ ...older, amount: 0.71 });
  });

  it('keeps the older record when it is the more complete one', () => {
    const older = ev({ source: 'eodhd', payDate: '2026-11-13' });
    expect(mergeDividendEvent(older, ev({ source: 'alphavantage', declared: true }))).toEqual({ ...older, declared: true });
  });
});

describe('mergeDividendEvents and withManualDividends', () => {
  it('merges lists by symbol and ex-date', () => {
    const merged = mergeDividendEvents([ev(), ev({ exDate: '2026-08-05' })], [ev({ payDate: '2026-11-13' })]);
    expect(merged.map((event) => event.exDate).sort()).toEqual(['2026-08-05', '2026-11-05']);
    expect(merged.find((event) => event.exDate === '2026-11-05')?.payDate).toBe('2026-11-13');
  });

  it('adds the entries of the owner to the stored events and lets a stored one with an amount win', () => {
    const stored = [ev({ source: 'eodhd', exDate: '2026-08-05' })];
    expect(withManualDividends(stored, [])).toEqual(stored);
    const merged = withManualDividends([...stored, ev({ source: 'eodhd', amount: 0.75 })], [manual({ amount: 0.7 }), manual({ exDate: '2027-02-05' })]);
    expect(merged).toHaveLength(3);
    expect(merged.find((event) => event.exDate === '2026-11-05')).toMatchObject({ source: 'eodhd', amount: 0.75, declared: true });
    expect(merged.find((event) => event.exDate === '2027-02-05')?.source).toBe(MANUAL_DIVIDEND_SOURCE);
  });
});
