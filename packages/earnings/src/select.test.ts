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
    // C's provider date is four days old: past the window, but its projection (2026-07-22 + 91 days = today) is due, so it keeps being looked at.
    expect(found).toEqual([{ symbol: 'A', mode: 'calendar' }, { symbol: 'B', mode: 'calendar' }, { symbol: 'C', mode: 'projected' }]);
  });

  it('a summary stored a day before the calendar date covers that report', () => {
    expect(select({ symbols: ['A'], calendar: { A: ['2026-10-21'] }, latestReport: new Map([['A', '2026-10-20']]), states: new Map([state('A', { lastCheckedAt: NOW.toISOString() })]) })).toEqual([]);
  });

  it('discovery mode: no calendar date and no projection due, at most once a UTC day', () => {
    const old = new Map([['F', '2026-06-01']]);
    expect(select({ symbols: ['F'], latestReport: old })).toEqual([{ symbol: 'F', mode: 'discovery' }]);
    expect(select({ symbols: ['F'], latestReport: old, states: new Map([state('F', { lastCheckedAt: '2026-10-21T05:00:00.000Z' })]) })).toEqual([]);
    expect(select({ symbols: ['F'], latestReport: old, states: new Map([state('F', { lastCheckedAt: '2026-10-20T23:59:00.000Z' })]) })).toEqual([{ symbol: 'F', mode: 'discovery' }]);
    expect(select({ symbols: ['F'], latestReport: old, calendar: { F: ['2026-10-01'] } })).toEqual([{ symbol: 'F', mode: 'discovery' }]);
  });

  it('an upcoming provider date no longer means wait when the newest release is old: providers list estimates that are often wrong', () => {
    const old = new Map([['F', '2026-06-01']]);
    expect(select({ symbols: ['F'], latestReport: old, calendar: { F: ['2026-10-29'] } })).toEqual([{ symbol: 'F', mode: 'discovery' }]);
    expect(select({ symbols: ['F'], latestReport: old, calendar: { F: ['2026-10-29'] }, states: new Map([state('F', { lastCheckedAt: NOW.toISOString() })]) })).toEqual([]);
    // A recent release (less than two months ago), or none stored at all (the backfill's work), keeps waiting for the date.
    expect(select({ symbols: ['F'], latestReport: new Map([['F', '2026-09-01']]), calendar: { F: ['2026-10-29'] } })).toEqual([]);
    expect(select({ symbols: ['F'], latestReport: new Map(), calendar: { F: ['2026-10-29'] } })).toEqual([]);
  });

  it('projected mode: no provider date and the projection (newest release + 91 days) is due or within five days', () => {
    const at = (latest: string) => select({ symbols: ['P'], latestReport: new Map([['P', latest]]) });
    expect(at('2026-07-22')).toEqual([{ symbol: 'P', mode: 'projected' }]);
    expect(at('2026-07-27')).toEqual([{ symbol: 'P', mode: 'projected' }]);
    expect(at('2026-07-28')).toEqual([{ symbol: 'P', mode: 'discovery' }]);
    expect(at('2026-08-25')).toEqual([]);
    // Overdue for 14 days is still due; at 15 the next quarter is the projection and only the daily discovery looks.
    expect(at('2026-07-08')).toEqual([{ symbol: 'P', mode: 'projected' }]);
    expect(at('2026-07-07')).toEqual([{ symbol: 'P', mode: 'discovery' }]);
    expect(select({ symbols: ['P'], latestReport: new Map([['P', '2026-07-22']]), states: new Map([state('P', { lastCheckedAt: NOW.toISOString() })]) })).toEqual([{ symbol: 'P', mode: 'projected' }]);
    expect(select({ symbols: ['P'], latestReport: new Map([['P', '2026-07-22']]), calendar: { P: ['2026-11-12'] } })).toEqual([{ symbol: 'P', mode: 'discovery' }]);
    expect(select({ symbols: ['P'], latestReport: new Map() })).toEqual([{ symbol: 'P', mode: 'discovery' }]);
  });

  it('a found release whose summary job was dropped or lost is looked at again on every run until the summary is stored', () => {
    const recent = new Map([['Q', '2026-10-01']]);
    const lost = state('Q', { pendingAccession: '0001-26-000001', pendingAt: '2026-10-21T10:00:00.000Z', lastCheckedAt: NOW.toISOString() });
    expect(select({ symbols: ['Q'], latestReport: recent, states: new Map([lost]) })).toEqual([{ symbol: 'Q', mode: 'calendar' }]);
    // Within the hour the summary job may still be running.
    expect(select({ symbols: ['Q'], latestReport: recent, states: new Map([state('Q', { pendingAccession: '0001-26-000001', pendingAt: '2026-10-21T19:00:00.000Z' })]) })).toEqual([]);
    expect(select({ symbols: ['Q'], latestReport: recent, states: new Map([state('Q', { lastCheckedAt: NOW.toISOString() })]) })).toEqual([]);
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
