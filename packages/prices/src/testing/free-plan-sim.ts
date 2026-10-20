import { MemoryItemStore, type Item, type ItemStore, type JobName, type Logger } from '@portfolio/platform';
import { parsePricesConfig } from '../config.js';
import type { PriceJobDeps } from '../jobs/common.js';
import { createPriceJobs } from '../service.js';

/**
 * Deterministic simulation of the owner's situation on the FREE plans: Twelve Data (8 credits per minute, `/profile` is not on
 * the plan), EODHD (20 calls a day, HTTP 402 afterwards), no Alpha Vantage key. A portfolio of invented symbols is enriched and
 * refreshed by the real jobs, driven like the Durable Object alarm queue (a step per alarm, the `delayMs` of a step moves the
 * clock, a failing step is retried with the queue's capped backoff). It counts what the Hub would burn per hour: alarm steps,
 * outbound subrequests and SQLite rows written. No network, no real clock.
 */

export const SIM_US = ['UAAA', 'UBBB', 'UCCC', 'UDDD', 'UEEE', 'UFFF', 'UGGG', 'UHHH', 'UIII', 'UJJJ', 'UKKK', 'ULLL', 'UMMM', 'UNNN'];
export const SIM_LISTED = ['LA01.DE', 'LB02.DE', 'LC03.AS', 'LD04.AS', 'LE05.MI', 'LF06.MI', 'LG07.DE', 'LH08.AS'];
export const SIM_FUNDS = ['ETFA.MI', 'ETFB.MI', 'ETFC.L', 'ETFD.L'];
export const SIM_SYMBOLS: readonly string[] = [...SIM_US, ...SIM_LISTED, ...SIM_FUNDS];

/** Tuesday 20 Oct 2026, 08:24 UTC: when the owner set the provider keys. */
export const SIM_START = Date.parse('2026-10-20T08:24:00.000Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;

const TD_CREDITS_PER_MINUTE = 8;
const EODHD_CALLS_PER_DAY = 20;
const QUEUE_MAX_ATTEMPTS = 5;
const QUEUE_BASE_BACKOFF_MS = 5000;
const QUEUE_MAX_BACKOFF_MS = 15 * MINUTE;
const MAX_STEPS = 20_000;

export interface HourStats {
  steps: number;
  fetches: number;
  rowsWritten: number;
}

export interface FreePlanReport {
  perHour: HourStats[];
  total: HourStats;
  /** Alarm steps per started minute, busiest minute. */
  maxStepsPerMinute: number;
  /** Symbols with a PROFILE item, by quality. */
  profiles: Map<string, Item>;
  missing: string[];
  minimal: string[];
  /** Provider calls answered with a limit error. */
  limited: { twelvedata: number; eodhd: number };
  failedJobs: number;
  /** Every outbound request, with the simulated time it was made. */
  requests: { at: number; url: string }[];
}

export interface SimJob {
  name: JobName;
  payload: unknown;
  /** Epoch ms the job is first due. */
  at: number;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const minuteOf = (ms: number): number => Math.floor(ms / MINUTE);
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/** A series of five daily closes ending on the clock's day. */
const history = (nowMs: number): { datetime: string; close: string }[] =>
  Array.from({ length: 5 }, (_, i) => ({ datetime: dayOf(nowMs - (4 - i) * 86_400_000), close: String(100 + i) }));

const symbolOf = (url: string, base: string): string => decodeURIComponent((new URL(url).pathname.split(base)[1] ?? '').split('/')[0] ?? '');
const queryOf = (url: string, name: string): string => new URL(url).searchParams.get(name) ?? '';

export interface FreeProviders {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  fetched: () => number;
  limited: () => { twelvedata: number; eodhd: number };
  /** Every outbound request, with the simulated time it was made. */
  log: () => { at: number; url: string }[];
}

/** The free-plan behaviour of the providers (see the file comment). */
export function freePlanProviders(now: () => number, universe: readonly string[] = SIM_SYMBOLS): FreeProviders {
  let fetched = 0;
  const requests: { at: number; url: string }[] = [];
  const limited = { twelvedata: 0, eodhd: 0 };
  const td = { minute: -1, credits: 0 };
  const eod = { day: '', calls: 0 };
  const isFund = (code: string): boolean => code.startsWith('ETF');

  const twelveCredits = (cost: number): Response | undefined => {
    const minute = minuteOf(now());
    if (td.minute !== minute) Object.assign(td, { minute, credits: 0 });
    if (td.credits + cost > TD_CREDITS_PER_MINUTE) {
      limited.twelvedata += 1;
      return json({ status: 'error', code: 429, message: 'You have run out of API credits for the current minute. Wait for the next minute or upgrade your plan.' });
    }
    td.credits += cost;
    return undefined;
  };

  const twelveData = (url: string): Response => {
    const path = new URL(url).pathname;
    if (path === '/profile') return json({ status: 'error', code: 403, message: 'This endpoint is available on the Grow plan or higher. Please upgrade.' });
    const symbols = queryOf(url, 'symbol').split(',');
    const limit = twelveCredits(path === '/quote' ? symbols.length : 1);
    if (limit) return limit;
    const symbol = symbols[0]!;
    if (path === '/time_series') return json({ meta: { currency: 'USD' }, values: history(now()) });
    if (path === '/stocks') return json({ data: [{ symbol, name: `Invented ${symbol} Inc`, currency: 'USD', exchange: 'NASDAQ', country: 'United States', type: 'Common Stock' }] });
    if (path === '/etfs') return json({ data: [] });
    const quote = (code: string) => ({ symbol: code, currency: 'USD', close: '101', previous_close: '100', timestamp: Math.floor(now() / 1000) });
    return json(symbols.length === 1 ? quote(symbol) : Object.fromEntries(symbols.map((code) => [code, quote(code)])));
  };

  const eodhdCost = (url: string): number => {
    const { pathname } = new URL(url);
    return pathname.startsWith('/api/real-time/') ? 1 + (queryOf(url, 's') === '' ? 0 : queryOf(url, 's').split(',').length) : 1;
  };

  const eodhd = (url: string): Response => {
    const day = dayOf(now());
    if (eod.day !== day) Object.assign(eod, { day, calls: 0 });
    if (eod.calls + eodhdCost(url) > EODHD_CALLS_PER_DAY) {
      limited.eodhd += 1;
      return new Response('Daily limit', { status: 402 });
    }
    eod.calls += eodhdCost(url);
    const { pathname } = new URL(url);
    if (pathname.startsWith('/api/search/')) {
      const code = symbolOf(url, '/api/search/');
      const known = universe.find((symbol) => symbol.split('.')[0] === code);
      const exchange = queryOf(url, 'exchange');
      return json(known === undefined ? [] : [{ Code: code, Exchange: exchange, Name: isFund(code) ? `Invented Fund ${code}` : `Invented ${code} AG`, Type: isFund(code) ? 'ETF' : 'Common Stock', Country: 'Germany', Currency: 'EUR', ISIN: 'IE00INVENT01' }]);
    }
    if (pathname.startsWith('/api/eod/')) return json(history(now()).map((row) => ({ date: row.datetime, close: Number(row.close) })));
    if (pathname.startsWith('/api/div/')) return json([]);
    const codes = [pathname.split('/api/real-time/')[1]!, ...queryOf(url, 's').split(',').filter((code) => code !== '')];
    const row = (code: string) => ({ code, close: 101, previousClose: 100, timestamp: Math.floor(now() / 1000) });
    return json(codes.length === 1 ? row(codes[0]!) : codes.map(row));
  };

  const frankfurter = (url: string): Response => {
    const range = /(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(url);
    if (range === null) return json({ base: 'EUR', date: dayOf(now()), rates: { USD: 1.16, GBP: 0.87 } });
    const rates: Record<string, unknown> = {};
    for (let ms = Date.parse(range[1]!); ms <= Date.parse(range[2]!); ms += 86_400_000) rates[dayOf(ms)] = { USD: 1.16, GBP: 0.87 };
    return json({ base: 'EUR', rates });
  };

  return {
    fetch: (url) => {
      fetched += 1;
      requests.push({ at: now(), url });
      if (url.includes('api.twelvedata.com')) return Promise.resolve(twelveData(url));
      if (url.includes('eodhd.com')) return Promise.resolve(eodhd(url));
      if (url.includes('frankfurter')) return Promise.resolve(frankfurter(url));
      return Promise.reject(new Error(`unexpected request ${url}`));
    },
    fetched: () => fetched,
    limited: () => ({ ...limited }),
    log: () => requests,
  };
}

const WRITE_METHODS = new Set(['put', 'update', 'delete']);

/** An ItemStore that counts the rows its writes touch (SQLite bills one row written per item, indexes aside). */
export function countingStore(inner: ItemStore): { store: ItemStore; rows: () => number } {
  let rows = 0;
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (property === 'batchWrite') rows += (args[0] as readonly unknown[]).length;
        else if (typeof property === 'string' && WRITE_METHODS.has(property)) rows += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store, rows: () => rows };
}

interface Queued {
  name: JobName;
  payload: unknown;
  cursor?: string;
  dueAt: number;
  attempts: number;
}

export interface FreePlanOptions {
  jobs: readonly SimJob[];
  hours: number;
  env?: Record<string, string | undefined>;
  symbols?: readonly string[];
  /** Replaces `createPriceJobs` (to simulate other job factories). */
  createJobs?: (deps: PriceJobDeps) => Record<string, unknown>;
  store?: MemoryItemStore;
  logger?: Logger;
}

/** Drives the jobs like the alarm queue and reports the burn per hour. */
export async function simulateFreePlan(options: FreePlanOptions): Promise<FreePlanReport> {
  let clock = SIM_START;
  const now = (): number => clock;
  const providers = freePlanProviders(now, options.symbols);
  const memory = options.store ?? new MemoryItemStore();
  const { store, rows } = countingStore(memory);
  const deps: PriceJobDeps = {
    store,
    fetch: (url, init) => providers.fetch(url, init),
    clock: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    config: parsePricesConfig({ TWELVEDATA_API_KEY: 'td-free-key', EODHD_API_KEY: 'eod-free-key', FX_HISTORY_START: '2026-10-19', ...options.env }),
    random: () => 0,
    logger: options.logger,
  };
  const handlers = (options.createJobs ?? createPriceJobs)(deps) as Record<string, (input: { payload: unknown; cursor?: string }) => Promise<{ done: boolean; next?: string; delayMs?: number }>>;
  const queue: Queued[] = options.jobs.map((job) => ({ name: job.name, payload: job.payload, dueAt: job.at, attempts: 0 }));
  const end = SIM_START + options.hours * HOUR;
  const perHour: HourStats[] = Array.from({ length: options.hours }, () => ({ steps: 0, fetches: 0, rowsWritten: 0 }));
  const perMinute = new Map<number, number>();
  let failedJobs = 0;

  /** Runs the next due step, then the one after it, until nothing is due before the end (the alarm runs one step at a time). */
  const runNext = async (count: number): Promise<void> => {
    const next = queue.toSorted((a, b) => a.dueAt - b.dueAt)[0];
    if (count >= MAX_STEPS || next === undefined || next.dueAt >= end) return;
    clock = Math.max(clock, next.dueAt);
    const hour = Math.min(options.hours - 1, Math.floor((clock - SIM_START) / HOUR));
    perMinute.set(minuteOf(clock), (perMinute.get(minuteOf(clock)) ?? 0) + 1);
    const before = { fetches: providers.fetched(), rows: rows() };
    queue.splice(queue.indexOf(next), 1);
    const outcome = await handlers[next.name]!({ payload: next.payload, cursor: next.cursor }).then(
      (step) => ({ step }),
      () => ({ step: undefined }),
    );
    const stats = perHour[hour]!;
    stats.steps += 1;
    stats.fetches += providers.fetched() - before.fetches;
    stats.rowsWritten += rows() - before.rows + 1;
    if (outcome.step === undefined) {
      next.attempts += 1;
      if (next.attempts >= QUEUE_MAX_ATTEMPTS) failedJobs += 1;
      else queue.push({ ...next, dueAt: clock + Math.min(QUEUE_MAX_BACKOFF_MS, QUEUE_BASE_BACKOFF_MS * 2 ** (next.attempts - 1)) });
    } else if (!outcome.step.done) {
      queue.push({ name: next.name, payload: next.payload, cursor: outcome.step.next, dueAt: clock + (outcome.step.delayMs ?? 0), attempts: 0 });
    }
    await runNext(count + 1);
  };
  await runNext(0);

  const items = memory.snapshot().filter((item) => item.SK === 'PROFILE');
  const profiles = new Map(items.map((item) => [String(item.symbol), item]));
  const universe = options.symbols ?? SIM_SYMBOLS;
  const total = perHour.reduce((sum, hourStats) => ({ steps: sum.steps + hourStats.steps, fetches: sum.fetches + hourStats.fetches, rowsWritten: sum.rowsWritten + hourStats.rowsWritten }), { steps: 0, fetches: 0, rowsWritten: 0 });
  return {
    perHour,
    total,
    maxStepsPerMinute: Math.max(0, ...perMinute.values()),
    profiles,
    missing: universe.filter((symbol) => !profiles.has(symbol)),
    minimal: universe.filter((symbol) => profiles.get(symbol)?.name === symbol),
    limited: providers.limited(),
    failedJobs,
    requests: providers.log(),
  };
}
