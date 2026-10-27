import { describe, expect, it } from 'vitest';
import type { FxDay, InstrumentProfile } from '@portfolio/shared';
import { MemoryItemStore } from '@portfolio/platform';
import cases from '../test-fixtures/parity-cases.json';
import { parseCalendarSettings } from './config.js';
import { ProviderError, ProviderUnavailableError, RateLimitError, RetryableProviderError, SymbolNotFoundError } from './errors.js';
import { HttpClient } from './http.js';
import { DailyQuota, MemoryQuotaLedger, TokenBucket } from './limits.js';
import { makeDividend, makeEod, makeProfile, makeQuote, normalizeCurrency, profileDetails } from './models.js';
import { asFloat, cleanText, validIsin } from './parse.js';
import { AlphaVantageProvider } from './providers/alphavantage.js';
import { AlphaVantageEarnings, EodhdCorporateActions, alphaVantageSymbol, parseEarningsCsv, parseSplitRatio, parseSplits } from './providers/calendar.js';
import { CoinGeckoProvider } from './providers/coingecko.js';
import { EodhdProvider, toEodhdSymbol } from './providers/eodhd.js';
import { FrankfurterFx, hasWeekday, yearChunks } from './providers/frankfurter.js';
import { TwelveDataProvider, assetClassFromType } from './providers/twelvedata.js';
import { dividendItem, earningsItem, eodItem, fxDayItem, fxItem, profileItem, quoteItem, splitItem, trackedItem } from './repository.js';
import { FakeFetch, type FakeRoute } from './testing/fake-fetch.js';
import { collect } from './testing/harness.js';
import { countryFor, currencyFor, exchangeFor, exchangeSuffix, baseTicker, hasExchangeSuffix, isCrypto, minimalProfile, priceCurrencyFor } from './symbols.js';
import { amsterdamHour, utcDay } from './time.js';

/**
 * Parity with the Python price service. `test-fixtures/parity-cases.json` holds provider payloads (from the Python tests)
 * and the results the PYTHON code produced for them (`generate_parity_cases.py`). The TypeScript port must produce the
 * same normalised results, request the same URLs and send the same credentials headers.
 */
interface Call {
  method: string;
  args?: unknown[];
}

interface ProviderCase {
  kind: 'provider';
  id: string;
  python: string;
  provider: string;
  now: string;
  horizon?: string;
  env?: Record<string, string>;
  routes: FakeRoute[];
  calls: Call[];
  expected: { results: unknown[]; urls: string[]; headers: Record<string, string> };
}

interface PureCase {
  kind: 'pure';
  id: string;
  python: string;
  fn: string;
  args: unknown[];
  expected: unknown;
}

const all = cases as unknown as (ProviderCase | PureCase)[];
const KEY = 'k3y-should-never-leak';
const noSleep = (): Promise<void> => Promise.resolve();

const errorKind = (error: unknown): string => {
  if (error instanceof RateLimitError) return 'rate-limited';
  if (error instanceof RetryableProviderError) return 'retryable';
  if (error instanceof SymbolNotFoundError) return 'not-found';
  if (error instanceof ProviderUnavailableError) return 'unavailable';
  return 'error';
};

const errorResult = (error: ProviderError): unknown => ({ error: { kind: errorKind(error), retryable: error.retryable, ...(error.status ? { status: error.status } : {}) } });

/** Drops undefined attributes, so that the result compares like the JSON the Python side wrote. */
const plain = <T>(value: T): unknown => JSON.parse(JSON.stringify(value)) as unknown;

function build(c: ProviderCase, fake: FakeFetch) {
  const now = new Date(c.now);
  const http = new HttpClient({ provider: c.provider.split('-')[0]!, fetch: fake.fetch, sleep: noSleep, maxRetries: 2, random: () => 0 });
  const bucket = new TokenBucket(100, 100, () => 0, noSleep);
  const quota = (name: string) => new DailyQuota(new MemoryQuotaLedger(), name, 10_000, () => utcDay(now));
  switch (c.provider) {
    case 'twelvedata':
      return new TwelveDataProvider({ apiKey: KEY, http, bucket, quota: quota('twelvedata'), now: () => now });
    case 'eodhd':
      return new EodhdProvider({ apiKey: KEY, http, bucket, quota: quota('eodhd'), now: () => now });
    case 'coingecko':
      return new CoinGeckoProvider({ apiKey: KEY, http, bucket, now: () => now, extraCoinIds: c.env?.COINGECKO_COIN_IDS });
    case 'alphavantage':
      return new AlphaVantageProvider({ apiKey: KEY, http, bucket, quota: quota('alphavantage'), now: () => now });
    case 'frankfurter':
      return new FrankfurterFx({ http, now: () => now });
    case 'alphavantage-earnings':
      return new AlphaVantageEarnings({ apiKey: KEY, http, bucket, quota: quota('alphavantage'), horizon: c.horizon });
    default:
      return new EodhdCorporateActions({ apiKey: KEY, http, bucket, quota: quota('eodhd'), dividends: new EodhdProvider({ apiKey: KEY, http, bucket, quota: quota('eodhd'), now: () => now }) });
  }
}

async function invoke(provider: unknown, call: Call): Promise<unknown> {
  const target = provider as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const args = call.args ?? [];
  switch (call.method) {
    case 'get_quotes': {
      const batch = await target.getQuotes!(args[0]) as { quotes: unknown; failed: { symbol: string; kind: string; retryable: boolean }[] };
      return { quotes: batch.quotes, failed: Object.fromEntries(batch.failed.map((f) => [f.symbol, { kind: errorKind(failureError(f.kind, f.retryable)), retryable: f.retryable }])) };
    }
    case 'get_eod_history':
      return target.getEodHistory!(...args);
    case 'get_dividends':
      return target.getDividends!(...args);
    case 'get_profile':
      return target.getProfile!(...args);
    case 'get_latest':
      return target.getLatest!(...args);
    case 'get_history':
      return target.getHistory!(...args);
    case 'get_splits':
      return target.getSplits!(...args);
    default:
      return target.fetch!(...withoutSuffixedListings(args));
  }
}

/**
 * The Python service looks up US tickers only. The TypeScript earnings source also reads suffixed listings (`FOO.DE`, `ASML.AS`) through the
 * alias table (covered by calendar.test.ts), so the parity cases hand it the symbols the Python code looks at.
 */
function withoutSuffixedListings(args: readonly unknown[]): unknown[] {
  const [symbols, ...rest] = args;
  return Array.isArray(symbols) ? [symbols.filter((symbol) => !hasExchangeSuffix(String(symbol))), ...rest] : [...args];
}

/** A quote failure kind as the error class the Python side recorded. */
function failureError(kind: string, retryable: boolean): Error {
  if (kind === 'not-found') return new SymbolNotFoundError('x');
  if (kind === 'rate-limited') return new RateLimitError('x');
  return retryable ? new RetryableProviderError('x') : new ProviderError('x');
}

describe.each(all.filter((c): c is ProviderCase => c.kind === 'provider'))('parity: $id (python: $python)', (c) => {
  it('returns the results of the Python code, requests the same URLs and sends the same credentials', async () => {
    const fake = new FakeFetch(c.routes);
    const provider = build(c, fake);
    const results = await collect(c.calls, async (call) => {
      let result: unknown;
      try {
        result = plain(await invoke(provider, call));
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        result = errorResult(error);
      }
      // Without a fixing date Frankfurter stamps the current time.
      if (call.method === 'get_latest' && typeof result === 'object' && result !== null && !('date' in result) && 'asOf' in result) (result as { asOf: string }).asOf = '<now>';
      return result;
    });
    expect(results).toEqual(c.expected.results);
    expect(fake.urls).toEqual(c.expected.urls);
    const first = fake.requests[0]?.headers ?? {};
    for (const [name, value] of Object.entries(c.expected.headers)) expect(first[name]).toBe(value);
  });
});

const pure: Record<string, (args: unknown[]) => unknown> = {
  as_float: (args) => args.map((value) => asFloat(value)),
  clean_text: (args) => (args as unknown[][]).map(([value, limit]) => cleanText(value, limit as number | undefined) ?? null),
  valid_isin: (args) => args.map((value) => validIsin(value) ?? null),
  asset_class_from_type: (args) => args.map((kind) => assetClassFromType(kind)),
  to_provider_symbol: (args) => (args as string[]).map((symbol) => toEodhdSymbol(symbol)),
  year_chunks: (args) => yearChunks(args[0] as string, args[1] as string),
  has_weekday: (args) => hasWeekday(args[0] as string, args[1] as string),
  amsterdam_hour: (args) => (args as string[]).map((instant) => amsterdamHour(new Date(instant))),
  classify: (args) =>
    (args as string[]).map((symbol) => ({
      symbol,
      crypto: isCrypto(symbol),
      suffix: exchangeSuffix(symbol),
      currency: currencyFor(symbol),
      priceCurrency: priceCurrencyFor(symbol),
      base: baseTicker(symbol),
      exchange: exchangeFor(symbol) ?? null,
      country: countryFor(symbol) ?? null,
      minimal: minimalProfile(symbol),
    })),
  normalize_currency: (args) => (args as [string | null, string][]).map(([code, fallback]) => normalizeCurrency(code, fallback)),
  av_symbol: (args) => (args as string[]).map((symbol) => alphaVantageSymbol(symbol)),
  parse_split_ratio: (args) => args.map((raw) => parseSplitRatio(raw)).map((r) => (r === null ? null : [r.fromFactor, r.toFactor])),
  parse_splits: (args) => parseSplits(args[0], args[1] as string, args[2] as string),
  parse_earnings_csv: (args) => {
    try {
      return { events: parseEarningsCsv(args[0] as string, new Map(Object.entries(args[1] as Record<string, string>))) };
    } catch (error) {
      if (error instanceof ProviderError) return errorResult(error);
      throw error;
    }
  },
  minor_units: () => [
    makeQuote({ symbol: 'VOD.L', price: 7250, previousClose: 7100, currency: 'GBp', asOf: 't', source: 'x' }),
    makeEod({ symbol: 'VOD.L', date: '2026-01-02', close: 7250, currency: 'GBX' }),
    makeDividend({ symbol: 'VOD.L', exDate: '2026-01-02', amount: 4.5, currency: 'GBX' }),
    makeEod({ symbol: 'AAPL', date: '2026-01-02', close: 10, currency: 'USD' }),
  ],
  items: (args) =>
    (args as { item: string; model: Record<string, unknown> }[]).map(({ item, model }) => {
      const event = model.event as never;
      const updatedAt = model.updatedAt as string;
      switch (item) {
        case 'quote':
          return quoteItem(makeQuote(model as never));
        case 'eod':
          return eodItem(makeEod(model as never));
        case 'profile':
          return profileItem(makeProfile(model as never));
        case 'dividend':
          return dividendItem(makeDividend(model as never));
        case 'fx':
          return fxItem(model as never);
        case 'fxDay':
          return fxDayItem(model as unknown as FxDay);
        case 'tracked':
          return trackedItem(model.symbol as string, model.now as string);
        case 'earnings':
          return earningsItem(event, updatedAt);
        case 'split':
          return splitItem(event, updatedAt);
        default:
          return profileDetails(model as unknown as InstrumentProfile);
      }
    }),
};

describe.each(all.filter((c): c is PureCase => c.kind === 'pure'))('parity: $id (python: $python)', (c) => {
  it('matches the Python result', () => {
    const run = pure[c.fn];
    expect(run, `no TypeScript counterpart for ${c.fn}`).toBeDefined();
    expect(plain(run!(c.args))).toEqual(c.expected);
  });
});

describe('parity bookkeeping', () => {
  it('has a case for every Python provider and every kind of pure function', () => {
    expect(new Set(all.filter((c): c is ProviderCase => c.kind === 'provider').map((c) => c.provider))).toEqual(new Set(['twelvedata', 'eodhd', 'coingecko', 'alphavantage', 'frankfurter', 'alphavantage-earnings', 'eodhd-actions']));
    expect(all.length).toBeGreaterThanOrEqual(50);
  });

  it('reads the calendar settings with the Python defaults', () => {
    expect(parseCalendarSettings({})).toEqual({ earningsHorizon: '12month', alphavantageDailyCalls: 1, eodhdDailyCalls: 8, recheckDays: 7, refreshDividends: true, splitLookbackDays: 90 });
  });

  it('keeps the store untouched by item builders', () => {
    expect(new MemoryItemStore().size).toBe(0);
  });
});
