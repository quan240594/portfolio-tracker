import { describe, expect, it } from 'vitest';
import type { EarningsHolding, EarningsSymbolState } from '@portfolio/shared';
import { MAX_CHECKS_PER_DAY, selectCandidates, type SelectInput } from './select.js';

const NOW = new Date('2026-10-21T19:30:00.000Z');
const TODAY = '2026-10-21';
const holding = (symbol: string): EarningsHolding => ({ symbol, name: symbol, template: 'generic' });
const state = (symbol: string, extra: Partial<EarningsSymbolState> = {}): [string, EarningsSymbolState] => [symbol, { symbol, updatedAt: NOW.toISOString(), ...extra }];

function select(input: Partial<SelectInput> & { symbols: string[] }) {
  const { symbols, ...rest } = input;
  return selectCandidates({ now: NOW, today: TODAY, holdings: symbols.map(holding), states: new Map(), latestReport: new Map(symbols.map((symbol) => [symbol, '2026-07-22'])), calendar: {}, ...rest });
}

describe('selectCandidates', () => {
  it('discovery waits until the newest stored release is about two months old', () => {
    const latestReport = new Map([['A', '2026-09-01'], ['B', '2026-08-21'], ['C', '2026-08-23']]);
    expect(select({ symbols: ['A', 'B', 'C'], latestReport }).map((candidate) => candidate.symbol)).toEqual(['B']);
  });

  it('calendar mode: a date within [today - 3, today] without a stored summary for it', () => {
    const calendar = { A: ['2026-10-21'], B: ['2026-10-18'], C: ['2026-10-17'], D: ['2026-10-22'], E: ['2026-10-19'] };
    const latestReport = new Map([['A', '2026-07-22'], ['B', '2026-07-22'], ['C', '2026-07-22'], ['D', '2026-07-22'], ['E', '2026-10-19']]);
    const found = select({ symbols: ['A', 'B', 'C', 'D', 'E'], calendar, latestReport, states: new Map(['C', 'D'].map((symbol) => state(symbol, { lastCheckedAt: NOW.toISOString() }))) });
    expect(found).toEqual([{ symbol: 'A', mode: 'calendar' }, { symbol: 'B', mode: 'calendar' }]);
  });

  it('a summary stored a day before the calendar date covers that report', () => {
    expect(select({ symbols: ['A'], calendar: { A: ['2026-10-21'] }, latestReport: new Map([['A', '2026-10-20']]), states: new Map([state('A', { lastCheckedAt: NOW.toISOString() })]) })).toEqual([]);
  });

  it('discovery mode: no calendar date, at most once a UTC day; an upcoming date means wait', () => {
    expect(select({ symbols: ['F'] })).toEqual([{ symbol: 'F', mode: 'discovery' }]);
    expect(select({ symbols: ['F'], states: new Map([state('F', { lastCheckedAt: '2026-10-21T05:00:00.000Z' })]) })).toEqual([]);
    expect(select({ symbols: ['F'], states: new Map([state('F', { lastCheckedAt: '2026-10-20T23:59:00.000Z' })]) })).toEqual([{ symbol: 'F', mode: 'discovery' }]);
    expect(select({ symbols: ['F'], calendar: { F: ['2026-10-29'] } })).toEqual([]);
    expect(select({ symbols: ['F'], calendar: { F: ['2026-10-01'] } })).toEqual([{ symbol: 'F', mode: 'discovery' }]);
  });

  it('has no backfill mode: the first quarters of every holding are the backfill job\'s work, a symbol without a stored release is only discovered', () => {
    const symbols = ['A', 'B', 'C', 'D', 'E'];
    const found = selectCandidates({ now: NOW, today: TODAY, holdings: symbols.map(holding), states: new Map(), latestReport: new Map(), calendar: {} });
    expect(found.map((candidate) => candidate.mode)).toEqual(['discovery', 'discovery', 'discovery', 'discovery', 'discovery']);
  });

  it('skips symbols that are backed off, pending, unknown to the SEC, or looked at too often today', () => {
    const calendar = { A: [TODAY], B: [TODAY], C: [TODAY], D: [TODAY], E: [TODAY], F: [TODAY] };
    const states = new Map([
      state('A', { retryAfter: '2026-10-21T20:00:00.000Z' }),
      state('B', { pendingAt: '2026-10-21T19:00:00.000Z' }),
      state('C', { cikMissingAt: '2026-10-01T00:00:00.000Z' }),
      state('D', { checksDay: '2026-10-21', checks: MAX_CHECKS_PER_DAY }),
      state('E', { retryAfter: '2026-10-21T19:00:00.000Z', pendingAt: '2026-10-20T10:00:00.000Z', cikMissingAt: '2026-08-01T00:00:00.000Z', checksDay: '2026-10-20', checks: 99 }),
    ]);
    expect(select({ symbols: ['A', 'B', 'C', 'D', 'E', 'F'], calendar, states }).map((candidate) => candidate.symbol)).toEqual(['E', 'F']);
  });

  it('a manual refresh picks only that held symbol, whatever its state', () => {
    const states = new Map([state('A', { retryAfter: '2027-01-01T00:00:00.000Z' })]);
    expect(select({ symbols: ['A', 'B'], manualSymbol: 'A', states })).toEqual([{ symbol: 'A', mode: 'manual' }]);
    expect(select({ symbols: ['A'], manualSymbol: 'X' })).toEqual([]);
  });
});
