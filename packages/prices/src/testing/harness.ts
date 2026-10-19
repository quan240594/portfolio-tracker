import { MemoryItemStore, runToCompletion, type JobHandler, type JobStep } from '@portfolio/platform';
import { sequentially } from '@portfolio/shared';
import { expect } from 'vitest';
import { parsePricesConfig, type Env } from '../config.js';
import type { PriceJobDeps } from '../jobs/common.js';
import { FakeFetch } from './fake-fetch.js';

/** Tuesday 13 Oct 2026, 18:30 in Amsterdam (inside the default EU refresh window). */
export const NOW = new Date('2026-10-13T16:30:00.000Z');
export const NOW_SECONDS = NOW.getTime() / 1000;

export const ALL_KEYS: Env = {
  TWELVEDATA_API_KEY: 'td-secret-key',
  EODHD_API_KEY: 'eod-secret-key',
  COINGECKO_API_KEY: 'cg-secret-key',
  ALPHAVANTAGE_API_KEY: 'av-secret-key',
  FX_HISTORY_START: '2026-10-01',
};

/** A pinned clock that only moves when the code under test sleeps (or the test advances it). */
export class TestClock {
  constructor(public current: Date = NOW) {}

  readonly now = (): Date => new Date(this.current);

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Harness {
  deps: PriceJobDeps;
  store: MemoryItemStore;
  fake: FakeFetch;
  clock: TestClock;
  sleeps: number[];
}

export interface HarnessOptions {
  env?: Env;
  fake?: FakeFetch;
  store?: MemoryItemStore;
  start?: Date;
  stepSubrequests?: number;
  marketData?: NonNullable<PriceJobDeps['marketData']>;
}

const NO_OPTIONS: HarnessOptions = {};

export function harness(options: HarnessOptions = NO_OPTIONS): Harness {
  const clock = new TestClock(options.start ?? NOW);
  const store = options.store ?? new MemoryItemStore();
  const fake = options.fake ?? new FakeFetch();
  const sleeps: number[] = [];
  const deps: PriceJobDeps = {
    store,
    fetch: fake.fetch,
    clock: clock.now,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
    config: parsePricesConfig({ ...ALL_KEYS, ...options.env }),
    random: () => 0,
    stepSubrequests: options.stepSubrequests,
    marketData: options.marketData,
  };
  return { deps, store, fake, clock, sleeps };
}

export function track(store: MemoryItemStore, ...symbols: string[]): void {
  store.load(symbols.map((symbol) => ({ PK: 'TRACKED', SK: `TICKER#${symbol}`, entityType: 'TRACKED_TICKER', symbol })));
}

/** Runs a job to the end like a budgeted adapter: every step is recorded, a `delayMs` moves the clock. */
export async function drive<P, R>(h: Harness, handler: JobHandler<P, R>, payload: P): Promise<{ result: R; steps: JobStep<R>[] }> {
  const steps: JobStep<R>[] = [];
  const result = await runToCompletion(handler, payload, {
    sleep: (ms) => {
      h.clock.advance(ms);
      return Promise.resolve();
    },
    onStep: (step) => steps.push(step as JobStep<R>),
  });
  return { result, steps };
}

export const tdQuote = (symbol: string, close: string, previous: string, timestamp = NOW_SECONDS) => ({ symbol, currency: 'USD', close, previous_close: previous, timestamp });

/** Typical live answers for AAPL (Twelve Data), ASML.AS (EODHD), BTC-EUR (CoinGecko) and the ECB (Frankfurter). */
export function liveFake(): FakeFetch {
  return new FakeFetch()
    .add('frankfurter.dev/v1/latest', { base: 'EUR', date: '2026-10-13', rates: { USD: 1.16, GBP: 0.87 } })
    .add('frankfurter.dev/v1/2026-10-01..2026-10-13', { base: 'EUR', rates: { '2026-10-01': { USD: 1.15, GBP: 0.86 }, '2026-10-02': { USD: 1.151, GBP: 0.861 } } })
    .add('twelvedata.com/quote', tdQuote('AAPL', '230.12', '228.5'))
    .add('eodhd.com/api/real-time/ASML.AS', { code: 'ASML.AS', close: 701.2, previousClose: 690, timestamp: NOW_SECONDS })
    .add('coingecko.com/api/v3/simple/price', { bitcoin: { eur: 60600, eur_24h_change: 1, last_updated_at: NOW_SECONDS } });
}

/** The results of `task` for the items, one after another. */
export async function collect<T, R>(items: Iterable<T>, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for await (const result of sequentially(items, task)) out.push(result);
  return out;
}

/** Runs a job to the end and delivers every step twice (as an at-least-once queue may): both deliveries must agree. */
export async function driveTwice<P, R>(h: Harness, handler: JobHandler<P, R>, payload: P, cursor?: string): Promise<R> {
  const step = await handler({ payload, cursor });
  expect(await handler({ payload, cursor })).toEqual(step);
  if (step.done) return step.result;
  if (step.delayMs) h.clock.advance(step.delayMs);
  return driveTwice(h, handler, payload, step.next);
}
