import { describe, expect, it } from 'vitest';
import type { CalendarState } from '../repository.js';
import { planRotation, type RotationContext } from './dividend-rotation.js';

const DAY = 86_400_000;
const NOW = new Date('2026-11-05T05:30:00.000Z');
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();
const read = (days: number): CalendarState => ({ splitsCheckedAt: ago(days), dividendsCheckedAt: ago(days) });

const plan = (symbols: string[], extra: Partial<RotationContext> = {}) =>
  planRotation(symbols, { now: NOW, mode: 'scheduled', recheckDays: 7, states: new Map(), dates: new Map(), heldSince: new Map(), ...extra });
const symbolsOf = (entries: ReturnType<typeof plan>): string[] => entries.map((entry) => entry.symbol);

describe('planRotation (the daily run)', () => {
  it('reads never read symbols first, then those whose ex-date is close or whose quarterly dividend is due to be declared, then the stalest', () => {
    const states = new Map([
      ['OLD', read(30)],
      ['OLDER', read(40)],
      ['CLOSE', read(4)],
      ['SOON', read(4)],
      ['QUIET', read(4)],
      ['FRESH', read(1)],
    ]);
    const dates = new Map([
      ['CLOSE', { last: '2026-10-30' }],
      ['SOON', { last: '2026-08-06' }],
      ['QUIET', { last: '2026-03-01' }],
      ['FRESH', { last: '2026-11-05' }],
    ]);
    const entries = plan(['QUIET', 'OLD', 'NEW', 'SOON', 'CLOSE', 'OLDER', 'FRESH'], { states, dates });
    expect(entries).toEqual([
      { symbol: 'NEW', tier: 'new', splits: true },
      { symbol: 'CLOSE', tier: 'near', splits: false },
      { symbol: 'SOON', tier: 'near', splits: false },
      { symbol: 'OLDER', tier: 'stale', splits: true },
      { symbol: 'OLD', tier: 'stale', splits: true },
    ]);
  });

  it('does not read a symbol twice within two days, however close its ex-date, nor one that is fine until its turn', () => {
    const states = new Map([
      ['A', read(1)],
      ['B', read(3)],
    ]);
    const dates = new Map([
      ['A', { last: '2026-11-04' }],
      ['B', { next: '2027-02-01', last: '2026-11-01' }],
    ]);
    expect(symbolsOf(plan(['A', 'B'], { states, dates }))).toEqual(['B']);
    expect(plan(['B'], { states: new Map([['B', read(3)]]), dates: new Map([['B', { next: '2027-02-01' }]]) })).toEqual([]);
    expect(plan(['B'], { states: new Map([['B', read(3)]]), dates: new Map([['B', { last: '2026-06-01', next: '2027-02-01' }]]) })).toEqual([]);
  });

  it('puts a symbol bought after its last read first, even when that read was yesterday', () => {
    const entries = plan(['AAA', 'HESM'], { states: new Map([['AAA', read(30)], ['HESM', read(1)]]), heldSince: new Map([['HESM', '2026-11-05']]) });
    expect(entries).toEqual([
      { symbol: 'HESM', tier: 'new', splits: false },
      { symbol: 'AAA', tier: 'stale', splits: true },
    ]);
    expect(symbolsOf(plan(['HESM'], { states: new Map([['HESM', read(1)]]), heldSince: new Map([['HESM', '2026-10-01']]) }))).toEqual([]);
  });

  it('counts only its own full reads (the enrichment reads the dividends but not the splits)', () => {
    expect(plan(['HESM'], { states: new Map([['HESM', { dividendsCheckedAt: ago(0) }]]) })).toEqual([{ symbol: 'HESM', tier: 'new', splits: true }]);
  });

  it('lets a symbol that failed within the interval wait its turn, behind those not attempted', () => {
    const states = new Map<string, CalendarState>([
      ['BAD', { splitsFailedAt: ago(1) }],
      ['OLD', read(30)],
    ]);
    expect(plan(['BAD', 'OLD'], { states })).toEqual([
      { symbol: 'OLD', tier: 'stale', splits: true },
      { symbol: 'BAD', tier: 'stale', splits: true },
    ]);
  });

  it('orders equals by the last attempt and then by name', () => {
    const states = new Map([
      ['B', read(30)],
      ['A', read(30)],
      ['C', read(20)],
    ]);
    expect(symbolsOf(plan(['C', 'B', 'A'], { states }))).toEqual(['A', 'B', 'C']);
  });
});

describe('planRotation (a manual check)', () => {
  const manual = (symbols: string[], extra: Partial<RotationContext> = {}) => plan(symbols, { mode: 'manual', ...extra });

  it('puts new symbols first, then symbols with no upcoming dividend stored, then those with one close by, then the rest', () => {
    const states = new Map([
      ['MISS', read(1)],
      ['CLOSE', read(1)],
      ['LATER', read(1)],
      ['NEWBUY', read(1)],
    ]);
    const dates = new Map([
      ['MISS', { last: '2026-08-01' }],
      ['CLOSE', { last: '2026-11-01', next: '2026-11-08' }],
      ['LATER', { last: '2026-08-01', next: '2027-02-01' }],
    ]);
    expect(manual(['LATER', 'CLOSE', 'MISS', 'NEWBUY', 'NEVER'], { states, dates, heldSince: new Map([['NEWBUY', '2026-11-05']]) })).toEqual([
      { symbol: 'NEVER', tier: 'new', splits: false },
      { symbol: 'NEWBUY', tier: 'new', splits: false },
      { symbol: 'MISS', tier: 'missing', splits: false },
      { symbol: 'CLOSE', tier: 'near', splits: false },
      { symbol: 'LATER', tier: 'stale', splits: false },
    ]);
  });

  it('counts a read by the enrichment and asks again whatever failed before', () => {
    expect(manual(['A'], { states: new Map([['A', { dividendsCheckedAt: ago(0), splitsFailedAt: ago(0) }]]), dates: new Map([['A', { next: '2026-12-01', last: '2026-09-01' }]]) })).toEqual([{ symbol: 'A', tier: 'stale', splits: false }]);
  });
});
