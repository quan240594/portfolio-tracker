import type { Item } from '@portfolio/platform';
import type { TransactionsChangedDetail } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { FakeFetch } from '../testing/fake-fetch.js';
import { NOW_SECONDS, drive, harness, type Harness } from '../testing/harness.js';
import { createEnrichTransactionsJob, MAX_ATTEMPTS_PER_DAY } from './enrich.js';
import { currencyMismatchReason, NO_DATA_REASON, NO_PROVIDER_REASON } from './history-override.js';

const ISIN = 'IE000000FWRA';
const event = (symbols: string[]): TransactionsChangedDetail => ({ userId: 'u1', portfolioId: 'p1', reason: 'CREATED', symbols });
const items = (store: Harness['store'], pk: string, prefix: string): Item[] => store.snapshot().filter((item) => item.PK === pk && item.SK.startsWith(prefix));
const stored = (store: Harness['store'], pk: string, sk: string): Item | undefined => store.snapshot().find((item) => item.PK === pk && item.SK === sk);
const calls = (fake: FakeFetch, part: string): number => fake.urls.filter((url) => url.includes(part)).length;
const rows = (from: number, to: number, bump = 0) => Array.from({ length: to - from + 1 }, (_, i) => ({ date: `2026-10-${String(from + i).padStart(2, '0')}`, close: 100 + i + bump }));

const profile = (extra: Record<string, unknown> = {}): Item => ({
  PK: 'TICKER#FWRA.MI',
  SK: 'PROFILE',
  entityType: 'PROFILE',
  symbol: 'FWRA.MI',
  name: 'World fund',
  assetClass: 'ETF',
  currency: 'EUR',
  isin: ISIN,
  profileSource: 'trading212',
  ...extra,
});

/** The profile of a symbol whose enrichment finished (an earlier run stored its history). */
const enriched = (): Item => profile({ profileSource: 'provider', enrichedAt: '2026-10-12' });

const override = (historySymbol: string, extra: Record<string, unknown> = {}): Item => ({ PK: 'TICKER#FWRA.MI', SK: 'HISTSYM', entityType: 'HISTORY_SYMBOL', historySymbol, status: 'pending', setAt: '2026-10-13T10:00:00.000Z', ...extra });

const eodRow = (date: string, extra: Record<string, unknown>): Item => ({ PK: 'TICKER#FWRA.MI', SK: `EOD#${date}`, entityType: 'EOD', symbol: 'FWRA.MI', date, close: 7, currency: 'EUR', ...extra });

/** EODHD that knows FWRA.DE and says `unknown` for FWRA.MI. */
const eodhd = (): FakeFetch =>
  new FakeFetch()
    .add('eodhd.com/api/eod/FWRA.MI', { status: 404 })
    .add('eodhd.com/api/eod/FWRA.XETRA', rows(8, 12))
    .add('eodhd.com/api/div/', [])
    .add('eodhd.com/api/real-time/', { status: 404 })
    .add(`eodhd.com/api/search/${ISIN}`, [{ Code: 'FWRA', Exchange: 'XETRA', Name: 'World fund', Currency: 'EUR', ISIN }]);

const run = (h: Harness, symbols = ['FWRA.MI']) => drive(h, createEnrichTransactionsJob(h.deps), event(symbols));
const recordOf = (h: Harness) => stored(h.store, 'TICKER#FWRA.MI', 'HISTSYM');

describe('the price history symbol set by the owner', () => {
  describe('for a symbol that is enriched for the first time', () => {
    it('takes the history from the owner’s symbol, without searching for a listing, and keeps the quote and live price off it', async () => {
      const fake = eodhd();
      const h = harness({ fake });
      h.store.load([profile(), override('FWRA.DE')]);
      const { result } = await run(h);
      expect(result).toMatchObject({ enriched: ['FWRA.MI'], retry: [] });
      const eod = items(h.store, 'TICKER#FWRA.MI', 'EOD#');
      expect(eod).toHaveLength(5);
      expect(eod[0]).toMatchObject({ symbol: 'FWRA.MI', currency: 'EUR', source: 'eodhd:FWRA.DE', override: true });
      expect(items(h.store, 'TICKER#FWRA.DE', 'EOD#')).toEqual([]);
      expect(recordOf(h)).toMatchObject({ historySymbol: 'FWRA.DE', status: 'applied' });
      expect(recordOf(h)).not.toHaveProperty('reason');
      expect(calls(fake, '/search/')).toBe(0);
      // the primary listing is still asked first (a later primary-provider history wins), then only the history of the owner's symbol
      expect(fake.urls.filter((url) => url.includes('/eod/')).map((url) => url.split('/eod/')[1]!.split('?')[0])).toEqual(['FWRA.MI', 'FWRA.XETRA']);
      // the quote is not asked from the history symbol: the history stands in only when the broker has none
      expect(calls(fake, '/real-time/')).toBe(0);
      expect(stored(h.store, 'TICKER#FWRA.MI', 'QUOTE#LATEST')).toMatchObject({ source: 'live-eod' });
    });

    it('leaves the quote of the broker alone and aligns the rows to its unit', async () => {
      const h = harness({ fake: eodhd() });
      h.store.load([profile(), override('FWRA.DE'), { PK: 'TICKER#FWRA.MI', SK: 'QUOTE#LATEST', entityType: 'QUOTE', symbol: 'FWRA.MI', price: 1.04, previousClose: 1.03, currency: 'EUR', asOf: '2026-10-13T16:00:00.000Z', source: 't212' }]);
      await run(h);
      expect(stored(h.store, 'TICKER#FWRA.MI', 'QUOTE#LATEST')).toMatchObject({ price: 1.04, source: 't212' });
      // 100..104 against a live price of 1.04 is a pence mix-up of a hundred: the rows are brought to the unit of the quote
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-12')).toMatchObject({ close: 1.04, source: 'eodhd:FWRA.DE', override: true });
    });

    it('lets the provider’s own history win when it knows the held symbol, and does not touch the history symbol', async () => {
      const fake = eodhd().add('eodhd.com/api/eod/FWRA.MI', rows(8, 12, 0.4)).add('eodhd.com/api/real-time/', { code: 'FWRA.MI', close: 104.4, previousClose: 103.4, timestamp: NOW_SECONDS });
      const h = harness({ fake });
      h.store.load([profile(), override('FWRA.DE'), eodRow('2026-10-12', { source: 'eodhd:FWRA.DE', override: true })]);
      await run(h);
      const row = stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-12');
      expect(row).toMatchObject({ close: 104.4 });
      expect(row).not.toHaveProperty('source');
      expect(row).not.toHaveProperty('override');
      expect(calls(fake, 'FWRA.XETRA')).toBe(0);
    });

    it('does not guess another listing when the owner named the held symbol itself', async () => {
      const fake = eodhd();
      const h = harness({ fake });
      h.store.load([profile(), override('FWRA.MI')]);
      const { result } = await run(h);
      expect(result).toMatchObject({ enriched: [] });
      expect(calls(fake, '/search/')).toBe(0);
      expect(items(h.store, 'TICKER#FWRA.MI', 'EOD#')).toEqual([]);
      expect(recordOf(h)).toMatchObject({ status: 'own' });
    });

    it('still looks for another listing of the same fund when the owner’s symbol has no data', async () => {
      const fake = eodhd().add('eodhd.com/api/eod/FWRA.XETRA', { status: 404 }).add('eodhd.com/api/eod/FWRA.AS', rows(8, 12));
      fake.add(`eodhd.com/api/search/${ISIN}`, [{ Code: 'FWRA', Exchange: 'AS', Name: 'World fund', Currency: 'EUR', ISIN }]);
      const h = harness({ fake });
      h.store.load([profile(), override('FWRA.DE')]);
      await run(h);
      expect(recordOf(h)).toMatchObject({ status: 'no-data', reason: NO_DATA_REASON });
      expect(items(h.store, 'TICKER#FWRA.MI', 'EOD#')[0]).toMatchObject({ source: 'eodhd:FWRA.AS' });
      expect(items(h.store, 'TICKER#FWRA.MI', 'EOD#')[0]).not.toHaveProperty('override');
    });
  });

  describe('for a symbol that is already enriched', () => {
    it('fetches only the history under the owner’s symbol, once', async () => {
      const fake = eodhd();
      const h = harness({ fake });
      h.store.load([enriched(), override('FWRA.DE')]);
      const { result } = await run(h);
      expect(result).toMatchObject({ symbols: 1, alreadyEnriched: 1, enriched: ['FWRA.MI'], retry: [] });
      expect(fake.urls).toHaveLength(1);
      expect(fake.urls[0]).toContain('eodhd.com/api/eod/FWRA.XETRA');
      expect(items(h.store, 'TICKER#FWRA.MI', 'EOD#')).toHaveLength(5);
      expect(items(h.store, 'TICKER#FWRA.MI', 'QUOTE#')).toEqual([]);
      expect(recordOf(h)).toMatchObject({ status: 'applied' });
      // nothing is pending any more: a second run makes no call
      const again = await run(h);
      expect(again.result).toMatchObject({ enriched: [] });
      expect(fake.urls).toHaveLength(1);
    });

    it('does nothing when the owner cleared it, and keeps the rows it stored, marked as from an override', async () => {
      const fake = eodhd();
      const h = harness({ fake });
      h.store.load([enriched(), eodRow('2026-10-12', { source: 'eodhd:FWRA.DE', override: true })]);
      await run(h);
      expect(fake.urls).toEqual([]);
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-12')).toMatchObject({ source: 'eodhd:FWRA.DE', override: true });
    });

    it('does not fetch a history symbol that is not pending', async () => {
      const fake = eodhd();
      const h = harness({ fake });
      h.store.load([enriched(), override('FWRA.DE', { status: 'refused', reason: 'x' })]);
      await run(h);
      expect(fake.urls).toEqual([]);
    });

    it('records the one the provider has no data for, and does not ask again', async () => {
      const fake = eodhd().add('eodhd.com/api/eod/FWRA.XETRA', { status: 404 });
      const h = harness({ fake });
      h.store.load([enriched(), override('FWRA.DE')]);
      const { result } = await run(h);
      expect(result).toMatchObject({ enriched: [], retry: [] });
      expect(recordOf(h)).toMatchObject({ status: 'no-data', reason: NO_DATA_REASON });
      expect(items(h.store, 'TICKER#FWRA.MI', 'EOD#')).toEqual([]);
      await run(h);
      expect(fake.urls).toHaveLength(1);
    });

    it('records that no provider is set up for the history symbol (no key)', async () => {
      const h = harness({ fake: eodhd(), env: { EODHD_API_KEY: '' } });
      h.store.load([enriched(), override('FWRA.DE')]);
      await run(h);
      expect(recordOf(h)).toMatchObject({ status: 'no-data', reason: NO_PROVIDER_REASON });
      expect(h.fake.urls).toEqual([]);
    });

    it('records that the owner’s symbol is the held one without fetching anything', async () => {
      const fake = eodhd();
      const h = harness({ fake });
      h.store.load([enriched(), override('FWRA.MI')]);
      await run(h);
      expect(recordOf(h)).toMatchObject({ status: 'own' });
      expect(fake.urls).toEqual([]);
    });
  });

  describe('what is recorded', () => {
    it('treats an empty history like no data', async () => {
      const h = harness({ fake: eodhd().add('eodhd.com/api/eod/FWRA.XETRA', []) });
      h.store.load([enriched(), override('FWRA.DE')]);
      await run(h);
      expect(recordOf(h)).toMatchObject({ status: 'no-data', reason: NO_DATA_REASON });
    });

    it('does not write the record again when what became of it did not change', async () => {
      const h = harness({ fake: eodhd().add('eodhd.com/api/eod/FWRA.XETRA', { status: 404 }) });
      const done = override('FWRA.DE', { status: 'no-data', reason: NO_DATA_REASON, setAt: 'kept' });
      h.store.load([profile(), done]);
      await run(h);
      expect(recordOf(h)).toEqual(done);
    });

    it('finishes in more steps when a step has too few subrequests for the primary history and the owner’s symbol together', async () => {
      const fake = eodhd();
      const h = harness({ fake, stepSubrequests: 2 });
      h.store.load([profile(), override('FWRA.DE')]);
      const { result, steps } = await run(h);
      expect(result).toMatchObject({ enriched: ['FWRA.MI'], retry: [] });
      expect(steps.length).toBeGreaterThan(1);
      expect(recordOf(h)).toMatchObject({ status: 'applied' });
      expect(items(h.store, 'TICKER#FWRA.MI', 'EOD#')).toHaveLength(5);
    });
  });

  describe('currency check', () => {
    const quotedInUsd = (): FakeFetch => eodhd().add('twelvedata.com/time_series', { meta: { currency: 'USD' }, values: [{ datetime: '2026-10-12', close: '104' }, { datetime: '2026-10-09', close: '101' }] });

    it('refuses a symbol quoted in another currency than the holding, stores nothing and says why', async () => {
      const h = harness({ fake: quotedInUsd() });
      h.store.load([enriched(), override('FWRA')]);
      const { result } = await run(h);
      expect(result).toMatchObject({ enriched: [], retry: [] });
      expect(items(h.store, 'TICKER#FWRA.MI', 'EOD#')).toEqual([]);
      expect(recordOf(h)).toMatchObject({ status: 'refused', reason: 'history symbol is quoted in USD, the holding in EUR' });
      expect(currencyMismatchReason('USD', 'EUR')).toBe('history symbol is quoted in USD, the holding in EUR');
    });

    it('refuses a London line for a euro holding (pence are pounds, not euros) and accepts it for a pound holding', async () => {
      const london = (): FakeFetch => eodhd().add('eodhd.com/api/eod/FWRA.LSE', rows(8, 12));
      const euro = harness({ fake: london() });
      euro.store.load([enriched(), override('FWRA.L')]);
      await run(euro);
      expect(recordOf(euro)).toMatchObject({ status: 'refused', reason: 'history symbol is quoted in GBP, the holding in EUR' });

      const pound = harness({ fake: london() });
      pound.store.load([profile({ currency: 'GBX', profileSource: 'provider', enrichedAt: '2026-10-12' }), override('FWRA.L')]);
      await run(pound);
      expect(recordOf(pound)).toMatchObject({ status: 'applied' });
      expect(stored(pound.store, 'TICKER#FWRA.MI', 'EOD#2026-10-12')).toMatchObject({ close: 1.04, currency: 'GBP', source: 'eodhd:FWRA.L', override: true });
    });

    it('takes the currency of the exchange suffix when the profile has none', async () => {
      const h = harness({ fake: quotedInUsd() });
      h.store.load([{ ...enriched(), currency: undefined }, override('FWRA')]);
      await run(h);
      expect(recordOf(h)).toMatchObject({ status: 'refused', reason: 'history symbol is quoted in USD, the holding in EUR' });
    });

    it('goes through when the currencies agree, whatever case the profile writes them in', async () => {
      const h = harness({ fake: eodhd() });
      h.store.load([profile({ profileSource: 'provider', enrichedAt: '2026-10-12', currency: 'eur' }), override('FWRA.DE')]);
      await run(h);
      expect(recordOf(h)).toMatchObject({ status: 'applied' });
    });
  });

  describe('precedence of the stored rows', () => {
    it('replaces automatic proxy rows and earlier override rows, never a provider row or the broker’s', async () => {
      const h = harness({ fake: eodhd() });
      h.store.load([
        enriched(),
        override('FWRA.DE'),
        eodRow('2026-10-08', { source: 'eodhd:FWRA.AS' }),
        eodRow('2026-10-09', {}),
        eodRow('2026-10-10', { source: 't212' }),
        eodRow('2026-10-11', { source: 'eodhd:FWRA.PA', override: true }),
      ]);
      await run(h);
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-08')).toMatchObject({ close: 100, source: 'eodhd:FWRA.DE', override: true });
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-09')).toMatchObject({ close: 7 });
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-09')).not.toHaveProperty('source');
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-10')).toMatchObject({ close: 7, source: 't212' });
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-11')).toMatchObject({ close: 103, source: 'eodhd:FWRA.DE', override: true });
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-12')).toMatchObject({ source: 'eodhd:FWRA.DE', override: true });
    });

    it('is never replaced by the automatic proxy, which still fills the days the override left', async () => {
      const fake = eodhd();
      const h = harness({ fake });
      h.store.load([profile(), eodRow('2026-10-10', { source: 'eodhd:FWRA.DE', override: true, close: 55 }), eodRow('2026-10-11', { source: 'eodhd:FWRA.AS', close: 56 })]);
      await run(h);
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-10')).toMatchObject({ close: 55, override: true });
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-11')).toMatchObject({ close: 103, source: 'eodhd:FWRA.DE' });
      expect(stored(h.store, 'TICKER#FWRA.MI', 'EOD#2026-10-11')).not.toHaveProperty('override');
    });
  });

  describe('failures', () => {
    it('counts a try when the provider fails, keeps the symbol pending and waits before the next one', async () => {
      const fake = eodhd().add('eodhd.com/api/eod/FWRA.XETRA', { status: 500 });
      const h = harness({ fake, stepSubrequests: 40 });
      h.store.load([enriched(), override('FWRA.DE')]);
      const step = await createEnrichTransactionsJob(h.deps)({ payload: event(['FWRA.MI']) });
      expect(step.done).toBe(false);
      expect(stored(h.store, 'TICKER#FWRA.MI', 'ENRICH#override')).toMatchObject({ attempts: 1, outcome: 'retry', day: '2026-10-13' });
      expect(stored(h.store, 'TICKER#FWRA.MI', 'ENRICH#core')).toBeUndefined();
      expect(recordOf(h)).toMatchObject({ status: 'pending' });
    });

    it('gives the symbol up after the tries of the day are used, and for the rest of the job', async () => {
      const fake = eodhd().add('eodhd.com/api/eod/FWRA.XETRA', { status: 500 });
      const h = harness({ fake });
      h.store.load([enriched(), override('FWRA.DE')]);
      const { result } = await run(h);
      expect(result).toMatchObject({ enriched: [], retry: ['FWRA.MI'] });
      expect(recordOf(h)).toMatchObject({ status: 'pending' });
    });

    it('does not start a symbol whose tries of today are used up, and waits for tomorrow', async () => {
      const fake = eodhd();
      const h = harness({ fake });
      h.store.load([enriched(), override('FWRA.DE'), { PK: 'TICKER#FWRA.MI', SK: 'ENRICH#override', entityType: 'ENRICH_STATE', symbol: 'FWRA.MI', day: '2026-10-13', attempts: MAX_ATTEMPTS_PER_DAY, outcome: 'retry', lastError: 'x' }]);
      const step = await createEnrichTransactionsJob(h.deps)({ payload: event(['FWRA.MI']) });
      expect(step).toMatchObject({ done: false, delayMs: expect.any(Number) });
      expect(fake.urls).toEqual([]);
    });

    it('drops a symbol that was only skipped all day', async () => {
      const h = harness({ fake: eodhd() });
      h.store.load([enriched(), override('FWRA.DE'), { PK: 'TICKER#FWRA.MI', SK: 'ENRICH#override', entityType: 'ENRICH_STATE', symbol: 'FWRA.MI', day: '2026-10-13', attempts: MAX_ATTEMPTS_PER_DAY, outcome: 'skipped', lastError: 'x' }]);
      const step = await createEnrichTransactionsJob(h.deps)({ payload: event(['FWRA.MI']) });
      expect(step).toMatchObject({ done: true });
      expect(h.fake.urls).toEqual([]);
    });

    it('waits for the daily limit of the provider without counting a try', async () => {
      const fake = eodhd().add('eodhd.com/api/eod/FWRA.XETRA', { status: 402 });
      const h = harness({ fake });
      h.store.load([enriched(), override('FWRA.DE')]);
      const step = await createEnrichTransactionsJob(h.deps)({ payload: event(['FWRA.MI']) });
      expect(step.done).toBe(false);
      expect(stored(h.store, 'TICKER#FWRA.MI', 'ENRICH#override')).toBeUndefined();
      expect(recordOf(h)).toMatchObject({ status: 'pending' });
    });
  });
});
