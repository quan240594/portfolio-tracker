import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALPHAVANTAGE_MIN_GAP_MS, ProviderPacer, pacedFetch } from './pacer.js';

describe('ProviderPacer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T08:20:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const realPacer = (minGapMs = ALPHAVANTAGE_MIN_GAP_MS) =>
    new ProviderPacer({ minGapMs, now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });

  it('lets the first request start at once', async () => {
    expect(await realPacer().wait('alphavantage')).toBe(0);
  });

  it('keeps two requests at least the gap apart: the second waits for what is left of it', async () => {
    const pacer = realPacer();
    const starts: number[] = [];
    const request = async () => {
      await pacer.wait('alphavantage');
      starts.push(Date.now());
    };
    const first = request();
    const second = request();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ALPHAVANTAGE_MIN_GAP_MS - 1);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(starts[1]! - starts[0]!).toBe(ALPHAVANTAGE_MIN_GAP_MS);
  });

  it('queues concurrent callers one gap apart each', async () => {
    const pacer = realPacer(1000);
    const starts: number[] = [];
    const t0 = Date.now();
    const calls = [0, 1, 2].map(async () => {
      await pacer.wait('alphavantage');
      starts.push(Date.now() - t0);
    });
    await vi.advanceTimersByTimeAsync(2500);
    await Promise.all(calls);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it('does not wait when the gap has passed since the last request, and waits only for the rest of it when part has', async () => {
    const pacer = realPacer(1500);
    await pacer.wait('alphavantage');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pacer.wait('alphavantage')).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    const rest = pacer.wait('alphavantage');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await rest).toBe(1000);
  });

  it('keeps each provider apart: another provider is not held back', async () => {
    const pacer = realPacer();
    await pacer.wait('alphavantage');
    expect(await pacer.wait('eodhd')).toBe(0);
  });

  it('asks the injected sleep for the wait (a timer is wall time, not CPU)', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const pacer = new ProviderPacer({ minGapMs: 1500, now: () => 10_000, sleep });
    await pacer.wait('alphavantage');
    expect(sleep).not.toHaveBeenCalled();
    await pacer.wait('alphavantage');
    expect(sleep).toHaveBeenCalledWith(1500);
  });
});

describe('pacedFetch', () => {
  it('waits for the pacer, then sends, with the url and init unchanged', async () => {
    const events: string[] = [];
    const inner = vi.fn(async (url: string) => {
      events.push(`fetch ${url}`);
      return new Response('{}');
    });
    const paced = pacedFetch(
      inner,
      {
        wait: (provider) => {
          events.push(`wait ${provider}`);
          return Promise.resolve(0);
        },
      },
      'alphavantage',
    );
    const init = { method: 'GET' };
    await paced('https://example.test/q', init);
    expect(events).toEqual(['wait alphavantage', 'fetch https://example.test/q']);
    expect(inner).toHaveBeenCalledWith('https://example.test/q', init);
  });
});
