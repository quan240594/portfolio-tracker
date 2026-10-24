import { describe, expect, it } from 'vitest';
import {
  COVERAGE_REASONS,
  coverageReason,
  coverageTotals,
  coverageWindowStart,
  historyStateOf,
  priceHistoryCoverageSchema,
  pricesStatusHistorySchema,
  sanitizeAttemptError,
  sortCoverage,
  summarizeEod,
  symbolCoverage,
  valuedAtCostOf,
  type CoverageAttempt,
  type EodSummary,
  type SymbolCoverageInput,
} from './price-coverage.js';

const TODAY = '2026-10-23';

const rows = (dates: readonly string[], source?: string) => dates.map((date) => ({ date, ...(source === undefined ? {} : { source }) }));
const eod = (dates: readonly string[], source?: string): EodSummary => summarizeEod(rows(dates, source), false);
const attempt = (over: Partial<CoverageAttempt> = {}): CoverageAttempt => ({ day: TODAY, attempts: 2, outcome: 'retry', error: 'boom', ...over });

const input = (over: Partial<SymbolCoverageInput> = {}): SymbolCoverageInput => ({
  symbol: 'AAPL',
  name: 'Apple',
  provider: 'twelvedata',
  keyConfigured: true,
  providerBlocked: false,
  firstTransaction: '2026-03-02',
  eod: eod([]),
  quote: null,
  attempt: null,
  ...over,
});

describe('summarizeEod', () => {
  it('reports rows, the first and last day and the distinct sources (a row without one is a provider row)', () => {
    expect(summarizeEod([...rows(['2026-10-02', '2026-10-01']), ...rows(['2026-10-03'], 't212')], false)).toEqual({
      rows: 3,
      first: '2026-10-01',
      last: '2026-10-03',
      sources: ['provider', 't212'],
      capped: false,
    });
  });

  it('is empty without rows', () => {
    expect(summarizeEod([], false)).toEqual({ rows: 0, first: null, last: null, sources: [], capped: false });
  });
});

describe('historyStateOf', () => {
  it('is missing without rows', () => {
    expect(historyStateOf(eod([]), '2026-03-02', TODAY)).toBe('missing');
  });

  it('is complete from the first transaction (a Sunday trade starts on Monday) up to within 4 days of today', () => {
    expect(historyStateOf(eod(['2026-03-03', '2026-10-19']), '2026-03-01', TODAY)).toBe('complete');
    expect(historyStateOf(eod(['2026-03-02', '2026-10-19']), '2026-03-02', TODAY)).toBe('complete');
  });

  it('measures from a year before today when the first transaction is older', () => {
    expect(historyStateOf(eod(['2025-10-24', '2026-10-23']), '2019-01-01', TODAY)).toBe('complete');
    expect(historyStateOf(eod(['2025-11-10', '2026-10-23']), '2019-01-01', TODAY)).toBe('partial');
  });

  it('is partial when the rows start late, or stop more than 4 days before today', () => {
    expect(historyStateOf(eod(['2026-06-01', '2026-10-23']), '2026-03-02', TODAY)).toBe('partial');
    expect(historyStateOf(eod(['2026-03-02', '2026-10-18']), '2026-03-02', TODAY)).toBe('partial');
  });

  it('is complete for a position opened today with one row', () => {
    expect(historyStateOf(eod([TODAY]), TODAY, TODAY)).toBe('complete');
  });

  it('a window starts at the first transaction when that is within the year', () => {
    expect(coverageWindowStart('2026-03-02', TODAY)).toBe('2026-03-02');
    expect(coverageWindowStart('2020-03-02', TODAY)).toBe('2025-10-23');
  });
});

describe('coverageReason', () => {
  const base = { state: 'missing' as const, keyConfigured: true, providerBlocked: false, attempt: null };

  it('says nothing is wrong for a complete history, whatever else is known', () => {
    expect(coverageReason({ ...base, state: 'complete', keyConfigured: false })).toBe(COVERAGE_REASONS.complete);
  });

  it('names a missing key first', () => {
    expect(coverageReason({ ...base, keyConfigured: false, attempt: attempt({ outcome: 'skipped' }) })).toBe(COVERAGE_REASONS.noKey);
  });

  it('a skipped attempt means the provider has no data', () => {
    expect(coverageReason({ ...base, attempt: attempt({ outcome: 'skipped', error: 'unknown symbol' }) })).toBe(COVERAGE_REASONS.noData);
  });

  it('a blocked provider or a quota-like error means waiting for the reset', () => {
    expect(coverageReason({ ...base, providerBlocked: true })).toBe(COVERAGE_REASONS.quota);
    expect(coverageReason({ ...base, attempt: attempt({ error: 'Daily credits exhausted (429)' }) })).toBe(COVERAGE_REASONS.quota);
  });

  it('any other failed attempt is retried automatically', () => {
    expect(coverageReason({ ...base, attempt: attempt() })).toBe(COVERAGE_REASONS.retrying);
  });

  it('without an attempt: not tried yet, or only part stored when there are rows', () => {
    expect(coverageReason(base)).toBe(COVERAGE_REASONS.notTried);
    expect(coverageReason({ ...base, state: 'partial' })).toBe(COVERAGE_REASONS.partial);
  });
});

describe('sanitizeAttemptError', () => {
  it('removes URLs, key parameters and long tokens, and keeps one line', () => {
    const raw = 'GET https://api.example.test/v1/eod?symbol=X&apikey=SECRETSECRETSECRETSECRET failed\n  token=abc and ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 too';
    const clean = sanitizeAttemptError(raw);
    expect(clean).toBe('GET [url] failed [redacted] and [redacted] too');
    expect(clean).not.toContain('SECRET');
  });

  it('cuts at 120 characters with an ellipsis', () => {
    const clean = sanitizeAttemptError('word '.repeat(60));
    expect(clean).toHaveLength(120);
    expect(clean.endsWith('…')).toBe(true);
  });

  it('is empty for a missing or non-text error', () => {
    expect(sanitizeAttemptError(undefined)).toBe('');
    expect(sanitizeAttemptError(42)).toBe('');
  });
});

describe('symbolCoverage and totals', () => {
  const complete = symbolCoverage(input({ symbol: 'ASML.AS', name: 'ASML', provider: 'eodhd', eod: eod(['2026-03-02', '2026-10-23'], 'eodhd'), quote: { asOf: '2026-10-23T08:00:00.000Z', source: 't212' } }), TODAY);
  const partial = symbolCoverage(input({ symbol: 'MSFT', name: 'Microsoft', eod: eod(['2026-08-03', '2026-10-23', '2026-10-22'], 't212'), attempt: attempt({ error: 'timeout' }) }), TODAY);
  const missing = symbolCoverage(input({ symbol: 'NOVO-B.CO', name: 'Novo', provider: 'eodhd', firstTransaction: '2026-01-05', keyConfigured: false }), TODAY);
  const missingToo = symbolCoverage(input({ symbol: 'ABBV', name: 'AbbVie', firstTransaction: '2026-02-02' }), TODAY);

  it('collects the facts of one symbol', () => {
    expect(complete).toMatchObject({
      symbol: 'ASML.AS',
      eodRows: 2,
      firstEod: '2026-03-02',
      lastEod: '2026-10-23',
      eodSources: ['eodhd'],
      lastQuoteAt: '2026-10-23T08:00:00.000Z',
      lastQuoteSource: 't212',
      historyState: 'complete',
      lastAttempt: null,
      reason: COVERAGE_REASONS.complete,
    });
    expect(partial).toMatchObject({ historyState: 'partial', reason: COVERAGE_REASONS.retrying, lastQuoteAt: null, lastQuoteSource: null, eodRows: 3 });
    expect(missing).toMatchObject({ historyState: 'missing', reason: COVERAGE_REASONS.noKey, eodRows: 0, firstEod: null, lastEod: null, eodSources: [] });
  });

  it('counts the states and finds the day the cost valuation starts and the day it ends', () => {
    expect(coverageTotals([complete, partial, missing, missingToo], 4, TODAY)).toEqual({
      held: 4,
      complete: 1,
      partial: 1,
      missing: 2,
      valuedAtCostSince: '2026-01-05',
      valuedAtCostUntil: TODAY,
      truncated: false,
    });
  });

  it('a partial symbol with a late start is valued at cost until its first row; one that only ends early is not', () => {
    expect(coverageTotals([partial], 1, TODAY)).toMatchObject({ valuedAtCostSince: '2026-03-02', valuedAtCostUntil: '2026-08-03' });
    const stale = symbolCoverage(input({ eod: eod(['2026-03-02', '2026-09-01']) }), TODAY);
    expect(stale.historyState).toBe('partial');
    expect(coverageTotals([stale], 1, TODAY)).toMatchObject({ valuedAtCostSince: null, valuedAtCostUntil: null });
  });

  it('flags a truncated list and has no cost valuation when everything is complete', () => {
    expect(coverageTotals([complete], 70, TODAY)).toMatchObject({ held: 70, truncated: true, valuedAtCostSince: null, valuedAtCostUntil: null });
  });

  it('lists the worst first, then by symbol', () => {
    expect(sortCoverage([complete, partial, missingToo, missing]).map((row) => row.symbol)).toEqual(['ABBV', 'NOVO-B.CO', 'MSFT', 'ASML.AS']);
  });

  it('the report and the status section match the schema', () => {
    const report = { asOf: '2026-10-23T09:00:00.000Z', symbols: sortCoverage([complete, partial, missing]), totals: coverageTotals([complete, partial, missing], 3, TODAY), rowsRead: 5 };
    expect(priceHistoryCoverageSchema.parse(report)).toEqual(report);
    expect(pricesStatusHistorySchema.parse({ history: report, other: 1 }).history).toEqual(report);
    expect(pricesStatusHistorySchema.parse({}).history).toBeUndefined();
    expect(pricesStatusHistorySchema.safeParse({ history: { ...report, totals: {} } }).success).toBe(false);
  });
});

describe('valuedAtCostOf', () => {
  it('is undefined when every day had a price', () => {
    expect(valuedAtCostOf({ costValued: [], held: 3 }, TODAY)).toBeUndefined();
  });

  it('lists the symbols sorted and the first day every one has a price', () => {
    expect(
      valuedAtCostOf(
        {
          costValued: [
            { symbol: 'ZZZ', from: '2026-01-05', to: '2026-10-22' },
            { symbol: 'AAA', from: '2026-03-02', to: '2026-06-30' },
          ],
          held: 5,
        },
        TODAY,
      ),
    ).toEqual({ symbols: ['AAA', 'ZZZ'], held: 5, until: TODAY });
  });

  it('never goes beyond the last day of the series', () => {
    expect(valuedAtCostOf({ costValued: [{ symbol: 'ZZZ', from: '2026-10-01', to: TODAY }], held: 1 }, TODAY)?.until).toBe(TODAY);
    expect(valuedAtCostOf({ costValued: [{ symbol: 'ZZZ', from: '2026-10-01', to: '2026-10-10' }], held: 1 }, TODAY)?.until).toBe('2026-10-11');
  });
});
