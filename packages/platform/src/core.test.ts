import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransactionsChangedDetail } from '@portfolio/shared';
import { base64ToBytes, decodeBase64, decodeBase64Url, encodeBase64, encodeBase64Url, utf8ByteLength } from './encoding.js';
import { QueueEventPublisher, RecordingEventPublisher } from './events.js';
import { beginsWith, cond, decodeCursor, encodeCursor, evaluateCondition, queryAll, UnprocessedItemsError, type Item } from './item-store.js';
import { JOBS, MAX_JOB_STEPS, runToCompletion, type JobHandler } from './job.js';
import { createConsoleLogger, logger, setLogger, silentLogger, type Logger } from './logger.js';
import { MemoryItemStore } from './memory/item-store.js';
import { MemoryJobQueue } from './memory/job-queue.js';
import { SCHEDULED_JOBS, toAwsCron, toUnixCron } from './schedule.js';
import { listByPrefix, listTransactions, putTransactions, registerUser, trackTickers } from './data/index.js';

describe('encoding', () => {
  it('encodes and decodes UTF-8 text as base64 (standard and URL-safe)', () => {
    expect(encodeBase64('key:secret')).toBe('a2V5OnNlY3JldA==');
    expect(decodeBase64('a2V5OnNlY3JldA==')).toBe('key:secret');
    expect(encodeBase64Url('€?>>')).toBe('4oKsPz4-');
    expect(decodeBase64Url('4oKsPz4-')).toBe('€?>>');
    expect(decodeBase64Url(encodeBase64Url('é'))).toBe('é');
    expect([...base64ToBytes('AQID')]).toEqual([1, 2, 3]);
    expect(utf8ByteLength('€')).toBe(3);
  });
});

describe('conditions', () => {
  const item: Item = { PK: 'p', SK: 's', status: 'RUNNING', at: '2026-01-02', n: 3, nothing: null };

  it('evaluates every kind against an item and against a missing one', () => {
    expect(evaluateCondition(item, cond.exists)).toBe(true);
    expect(evaluateCondition(undefined, cond.exists)).toBe(false);
    expect(evaluateCondition(undefined, cond.notExists)).toBe(true);
    expect(evaluateCondition(item, cond.notExists)).toBe(false);
    expect(evaluateCondition(item, cond.attrMissing('x'))).toBe(true);
    expect(evaluateCondition(undefined, cond.attrMissing('x'))).toBe(true);
    expect(evaluateCondition(item, cond.eq('status', 'RUNNING'))).toBe(true);
    expect(evaluateCondition(item, cond.ne('status', 'RUNNING'))).toBe(false);
    expect(evaluateCondition(item, cond.lt('at', '2026-02-01'))).toBe(true);
    expect(evaluateCondition(item, cond.lt('n', 'text'))).toBe(false);
    expect(evaluateCondition(item, cond.oneOf('status', ['A', 'RUNNING']))).toBe(true);
    expect(evaluateCondition(item, cond.and(cond.exists, cond.eq('n', 3)))).toBe(true);
    expect(evaluateCondition(item, cond.or(cond.eq('n', 4), cond.eq('n', 3)))).toBe(true);
  });

  it('makes comparisons on missing or null attributes false', () => {
    for (const make of [cond.eq, cond.ne, cond.lt]) {
      expect(evaluateCondition(item, make('missing', 'x'))).toBe(false);
      expect(evaluateCondition(item, make('nothing', 'x'))).toBe(false);
    }
  });
});

describe('item store helpers', () => {
  it('round-trips cursors and rejects garbage', () => {
    expect(decodeCursor(encodeCursor({ SK: 'a' }))).toEqual({ SK: 'a' });
    expect(() => decodeCursor('%%%')).toThrow('Invalid query cursor');
  });

  it('describes unprocessed items', () => {
    const error = new UnprocessedItemsError(3, 8);
    expect(error).toMatchObject({ name: 'UnprocessedItemsError', unprocessed: 3, message: 'BatchWrite: 3 unprocessed items after 8 attempts' });
  });

  it('queryAll follows cursors and beginsWith builds a prefix query', async () => {
    const store = new MemoryItemStore();
    await store.batchWrite(Array.from({ length: 5 }, (_, i) => ({ type: 'put' as const, item: { PK: 'p', SK: `A#${i}` } })));
    expect(await queryAll(store, { pk: 'p', limit: 2 })).toHaveLength(5);
    expect(beginsWith('p', 'A#', { consistent: true })).toEqual({ pk: 'p', sk: { beginsWith: 'A#' }, consistent: true });
    expect(beginsWith('p', 'A#')).toEqual({ pk: 'p', sk: { beginsWith: 'A#' } });
  });
});

describe('runToCompletion', () => {
  it('runs the steps of a job back to back and honours delays', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const onStep = vi.fn();
    const handler: JobHandler<string, string> = ({ payload, cursor }) =>
      Promise.resolve(cursor === undefined ? { done: false, next: '1', delayMs: 25 } : { done: true, result: `${payload}-${cursor}` });
    expect(await runToCompletion(handler, 'job', { sleep, onStep })).toBe('job-1');
    expect(sleep).toHaveBeenCalledWith(25);
    expect(onStep).toHaveBeenCalledTimes(2);
  });

  it('sleeps for real by default', async () => {
    vi.useFakeTimers();
    const handler: JobHandler<null, number> = ({ cursor }) => Promise.resolve(cursor ? { done: true, result: 1 } : { done: false, next: 'x', delayMs: 10 });
    const run = runToCompletion(handler, null);
    await vi.advanceTimersByTimeAsync(10);
    expect(await run).toBe(1);
    vi.useRealTimers();
  });

  it('gives up on a job that never finishes', async () => {
    const forever: JobHandler = () => Promise.resolve({ done: false, next: 'again' });
    await expect(runToCompletion(forever, null, { maxSteps: 3 })).rejects.toThrow('Job did not finish within 3 steps');
    expect(MAX_JOB_STEPS).toBeGreaterThan(100);
  });
});

describe('events', () => {
  const detail: TransactionsChangedDetail = { userId: 'u', portfolioId: 'p', symbols: ['AAPL'], reason: 'CREATED' };

  it('turns transactionsChanged into an enrichTransactions job', async () => {
    const queue = new MemoryJobQueue();
    await new QueueEventPublisher(queue).transactionsChanged(detail);
    expect(queue.enqueued).toEqual([{ job: JOBS.enrichTransactions, payload: detail }]);
  });

  it('records what it publishes', async () => {
    const events = new RecordingEventPublisher();
    await events.transactionsChanged(detail);
    expect(events.published).toEqual([detail]);
  });
});

describe('schedule', () => {
  it('derives the AWS and the Unix cron expressions', () => {
    const [refresh, calendar] = SCHEDULED_JOBS;
    expect(toAwsCron(refresh)).toBe('cron(0 8,13,18,22 ? * MON-FRI *)');
    expect(toUnixCron(refresh)).toBe('0 8,13,18,22 * * MON-FRI');
    expect(toAwsCron(calendar)).toBe('cron(30 5 * * ? *)');
    expect(toUnixCron(calendar)).toBe('30 5 * * *');
  });

  it('writes minute lists into both expressions', () => {
    const quotes = SCHEDULED_JOBS.find((s) => s.name === 't212-quotes')!;
    expect(toUnixCron(quotes)).toBe('0,15,30,45 7,8,9,10,11,12,13,14,15,16,17,18,19,20,21 * * MON-FRI');
    expect(toAwsCron(quotes)).toBe('cron(0,15,30,45 7,8,9,10,11,12,13,14,15,16,17,18,19,20,21 ? * MON-FRI *)');
    expect(toUnixCron(SCHEDULED_JOBS.find((s) => s.name === 't212-quotes-close')!)).toBe('5 22 * * MON-FRI');
  });

  it('declares one schedule per job with unique names', () => {
    expect(new Set(SCHEDULED_JOBS.map((s) => s.name)).size).toBe(SCHEDULED_JOBS.length);
    expect(SCHEDULED_JOBS.map((s) => s.job)).toEqual(['refreshPrices', 'refreshCalendar', 'syncBroker', 'syncBroker', 'notifyDividends', 'refreshT212Quotes', 'refreshT212Quotes']);
  });

  it('adds the intraday sync and the notification run on Cloudflare only, leaving the AWS schedules as they were', () => {
    const intraday = SCHEDULED_JOBS.find((s) => s.name === 'broker-sync-intraday')!;
    expect(intraday).toMatchObject({ job: 'syncBroker', payload: { all: true }, timezone: 'Europe/Amsterdam', minute: 30, hours: [12, 18, 22], weekdaysOnly: true, cloudflareOnly: true });
    expect(toUnixCron(intraday)).toBe('30 12,18,22 * * MON-FRI');
    const notify = SCHEDULED_JOBS.find((s) => s.name === 'notify-dividends')!;
    expect(notify).toMatchObject({ job: 'notifyDividends', payload: { trigger: 'scheduled' }, timezone: 'Europe/Amsterdam', hours: [9], cloudflareOnly: true });
    expect(toUnixCron(notify)).toBe('0 9 * * *');
    const daily = SCHEDULED_JOBS.find((s) => s.name === 'broker-sync')!;
    expect([daily.hours, daily.weekdaysOnly, daily.cloudflareOnly]).toEqual([[6], false, undefined]);
    expect(SCHEDULED_JOBS.filter((s) => s.cloudflareOnly !== true).map((s) => s.name)).toEqual(['prices-refresh', 'prices-calendar', 'broker-sync']);
  });
});

describe('logger', () => {
  afterEach(() => setLogger(silentLogger));

  it('drops everything by default', () => {
    logger.info('x');
    logger.appendKeys({ a: 1 });
    logger.removeKeys(['a']);
    expect(logger.createChild({ persistentKeys: { a: 1 } })).toBe(silentLogger);
    for (const level of ['debug', 'warn', 'error'] as const) expect(() => silentLogger[level]('x')).not.toThrow();
  });

  it('forwards to the installed logger', () => {
    const calls: string[] = [];
    const impl: Logger = {
      debug: (m) => {
        calls.push(`debug:${m}`);
      },
      info: (m) => {
        calls.push(`info:${m}`);
      },
      warn: (m) => {
        calls.push(`warn:${m}`);
      },
      error: (m) => {
        calls.push(`error:${m}`);
      },
      appendKeys: () => {
        calls.push('append');
      },
      removeKeys: () => {
        calls.push('remove');
      },
      createChild: () => impl,
    };
    setLogger(impl);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.appendKeys({});
    logger.removeKeys([]);
    expect(logger.createChild()).toBe(impl);
    expect(calls).toEqual(['debug:d', 'info:i', 'warn:w', 'error:e', 'append', 'remove']);
  });

  it('writes JSON lines with persistent keys, children and serialised errors', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const base = createConsoleLogger({ service: 's' });
    base.appendKeys({ requestId: 'r' });
    base.info('hello', { n: 1 });
    base.removeKeys(['requestId']);
    base.createChild({ persistentKeys: { userId: 'u' } }).error('bad', { error: new Error('boom') });
    base.createChild().debug('d');
    base.warn('w');
    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines[0]).toEqual({ level: 'INFO', message: 'hello', service: 's', requestId: 'r', n: 1 });
    expect(lines[1]).toEqual({ level: 'ERROR', message: 'bad', service: 's', userId: 'u', error: { name: 'Error', message: 'boom' } });
    expect(lines.map((l) => l.level)).toEqual(['INFO', 'ERROR', 'DEBUG', 'WARN']);
    log.mockRestore();
  });
});

describe('data helpers', () => {
  it('registers a user once and keeps createdAt', async () => {
    const store = new MemoryItemStore();
    await registerUser(store, 'u1', 't1');
    await registerUser(store, 'u1', 't2');
    expect(await store.get({ PK: 'USERS', SK: 'USER#u1' })).toEqual({ PK: 'USERS', SK: 'USER#u1', entityType: 'USER', userId: 'u1', createdAt: 't1', updatedAt: 't2' });
  });

  it('tracks market tickers only, keeping the first currency', async () => {
    const store = new MemoryItemStore();
    await trackTickers(store, [{ symbol: 'AAPL', currency: 'USD' }, { symbol: 'CASH.EUR', currency: 'EUR' }, { symbol: 'CUSTOM:x', currency: 'EUR' }, { symbol: 'NVDA' }], 'now');
    await trackTickers(store, [{ symbol: 'AAPL', currency: 'EUR' }], 'later');
    expect(store.snapshot().map((i) => i.SK).sort((a, b) => a.localeCompare(b))).toEqual(['TICKER#AAPL', 'TICKER#NVDA']);
    expect(await store.get({ PK: 'TRACKED', SK: 'TICKER#AAPL' })).toEqual({ PK: 'TRACKED', SK: 'TICKER#AAPL', entityType: 'TRACKED_TICKER', symbol: 'AAPL', currency: 'USD', createdAt: 'now', updatedAt: 'later' });
    expect(await store.get({ PK: 'TRACKED', SK: 'TICKER#NVDA' })).not.toHaveProperty('currency');
    await trackTickers(store, [], 'x');
  });

  it('writes and lists transactions per portfolio and per user', async () => {
    const store = new MemoryItemStore();
    const txn = (id: string, portfolioId: string) => ({ id, userId: 'u', portfolioId, date: '2026-01-01', type: 'BUY' as const, symbol: 'AAPL', quantity: 1, price: 1, fee: 0, currency: 'USD', createdAt: 'c' });
    await putTransactions(store, [txn('a', 'p1'), txn('b', 'p2')]);
    expect((await listTransactions(store, 'u')).map((t) => t.id).sort((a, b) => a.localeCompare(b))).toEqual(['a', 'b']);
    expect((await listTransactions(store, 'u', 'p1')).map((t) => t.id)).toEqual(['a']);
    expect(await listTransactions(store, 'other')).toEqual([]);
    expect(await listByPrefix(store, 'USER#u', 'NOPE#', { consistent: true })).toEqual([]);
  });
});
