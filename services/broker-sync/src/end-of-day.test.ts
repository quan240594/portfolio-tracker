import type { Quote } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { MAX_QUOTE_AGE_MS, calendarDay, endOfDayRows, freshQuotes, snapshotMode } from './end-of-day.js';

const quote = (symbol: string, over: Partial<Quote> = {}): Quote => ({ symbol, price: 10, previousClose: 9, currency: 'EUR', asOf: '2026-10-20T20:05:00.000Z', source: 't212', ...over });

describe('calendarDay', () => {
  it('reads the day on the clock of the zone, summer and winter time, across midnight', () => {
    expect(calendarDay(new Date('2026-10-20T20:05:00Z'), 'Europe/Amsterdam')).toEqual({ date: '2026-10-20', weekend: false });
    expect(calendarDay(new Date('2026-10-20T22:30:00Z'), 'Europe/Amsterdam')).toEqual({ date: '2026-10-21', weekend: false });
    expect(calendarDay(new Date('2026-12-01T21:30:00Z'), 'Europe/Amsterdam')).toEqual({ date: '2026-12-01', weekend: false });
    expect(calendarDay(new Date('2026-12-01T23:30:00Z'), 'Europe/Amsterdam')).toEqual({ date: '2026-12-02', weekend: false });
  });

  it('flags Saturday and Sunday of the zone, not of UTC', () => {
    expect(calendarDay(new Date('2026-10-24T10:00:00Z'), 'Europe/Amsterdam').weekend).toBe(true);
    expect(calendarDay(new Date('2026-10-25T10:00:00Z'), 'Europe/Amsterdam').weekend).toBe(true);
    // Friday 23:30 UTC is already Saturday in Amsterdam; Sunday 23:30 UTC is already Monday
    expect(calendarDay(new Date('2026-10-23T23:30:00Z'), 'Europe/Amsterdam')).toEqual({ date: '2026-10-24', weekend: true });
    expect(calendarDay(new Date('2026-10-25T23:30:00Z'), 'Europe/Amsterdam')).toEqual({ date: '2026-10-26', weekend: false });
  });
});

describe('snapshotMode', () => {
  const tuesday = { date: '2026-10-20', weekend: false };
  const seeded = { eodSeededAt: '2026-10-19T20:05:00.000Z' };

  it('is none at weekends, whatever the run', () => {
    expect(snapshotMode('close', null, { date: '2026-10-24', weekend: true })).toBe('none');
    expect(snapshotMode('scheduled', null, { date: '2026-10-24', weekend: true })).toBe('none');
  });

  it('closes once a day, on the close run', () => {
    expect(snapshotMode('close', seeded, tuesday)).toBe('close');
    expect(snapshotMode('close', { ...seeded, eodClosedDay: '2026-10-19' }, tuesday)).toBe('close');
    expect(snapshotMode('close', { ...seeded, eodClosedDay: '2026-10-20' }, tuesday)).toBe('none');
  });

  it('seeds on the first run after the feature appeared, whatever its trigger, and then never on other runs', () => {
    expect(snapshotMode('scheduled', null, tuesday)).toBe('seed');
    expect(snapshotMode('sync', {}, tuesday)).toBe('seed');
    expect(snapshotMode('close', { eodClosedDay: '2026-10-20' }, tuesday)).toBe('seed');
    expect(snapshotMode('scheduled', seeded, tuesday)).toBe('none');
    expect(snapshotMode('sync', seeded, tuesday)).toBe('none');
  });
});

describe('freshQuotes', () => {
  const now = new Date('2026-10-20T20:05:00.000Z');

  it('keeps Trading 212 quotes up to 36 hours old and drops older ones and other sources', () => {
    const at = (ageMs: number) => new Date(now.getTime() - ageMs).toISOString();
    const kept = freshQuotes([quote('A'), quote('B', { asOf: at(MAX_QUOTE_AGE_MS) }), quote('C', { asOf: at(MAX_QUOTE_AGE_MS + 1) }), quote('D', { source: 'twelvedata' })], now);
    expect(kept.map((q) => q.symbol)).toEqual(['A', 'B']);
  });
});

describe('endOfDayRows', () => {
  it('writes the quote price as the close of the day, source t212, in major units', () => {
    expect(endOfDayRows([quote('VUSA.L', { price: 9650, currency: 'GBX' }), quote('SAP.DE', { price: 231.4 })], '2026-10-20', new Map())).toEqual([
      { symbol: 'VUSA.L', date: '2026-10-20', close: 96.5, currency: 'GBP', source: 't212' },
      { symbol: 'SAP.DE', date: '2026-10-20', close: 231.4, currency: 'EUR', source: 't212' },
    ]);
  });

  it('skips a symbol a provider already has a row for, and replaces a t212 row', () => {
    const existing = new Map<string, string | undefined>([['A', undefined], ['B', 'twelvedata'], ['C', 't212']]);
    expect(endOfDayRows([quote('A'), quote('B'), quote('C'), quote('D')], '2026-10-20', existing).map((row) => row.symbol)).toEqual(['C', 'D']);
  });

  it('replaces a row that was taken from another listing of the same fund: the quote is the symbol’s own price', () => {
    const existing = new Map<string, string | undefined>([['FWRA.MI', 'eodhd:FWRA.DE'], ['A', 'eodhd']]);
    expect(endOfDayRows([quote('FWRA.MI'), quote('A')], '2026-10-20', existing).map((row) => row.symbol)).toEqual(['FWRA.MI']);
  });
});
