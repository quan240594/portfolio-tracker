import { describe, expect, it, vi } from 'vitest';
import { allSettledOrThrow, drain, groupBy, paginate, retryAttempts, sequentially } from './async.js';

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('sequentially', () => {
  it('runs tasks one at a time, in order, yielding each result', async () => {
    const trace: string[] = [];
    const results = await collect(
      sequentially([1, 2, 3], async (n) => {
        trace.push(`start ${n}`);
        await tick();
        trace.push(`end ${n}`);
        return n * 10;
      }),
    );
    expect(results).toEqual([10, 20, 30]);
    expect(trace).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });

  it('accepts an async source and is lazy: nothing runs until pulled', async () => {
    async function* source() {
      yield 'a';
      yield 'b';
    }
    const task = vi.fn(async (s: string) => s.toUpperCase());
    const gen = sequentially(source(), task);
    expect(task).not.toHaveBeenCalled();
    expect(await collect(gen)).toEqual(['A', 'B']);
  });

  it('stops at the first failure without starting later tasks', async () => {
    const task = vi.fn(async (n: number) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    await expect(drain(sequentially([1, 2, 3], task))).rejects.toThrow('boom');
    expect(task.mock.calls.map(([n]) => n)).toEqual([1, 2]);
  });
});

describe('drain', () => {
  it('consumes the whole iterable', async () => {
    const seen: number[] = [];
    await drain(sequentially([1, 2], async (n) => seen.push(n)));
    expect(seen).toEqual([1, 2]);
  });
});

describe('retryAttempts', () => {
  const opts = (sleep = vi.fn(async (_ms: number) => {})) => ({ sleep, delayMs: (n: number) => n * 100 });

  it('yields the first attempt without sleeping and stops when the consumer returns', async () => {
    const o = opts();
    const attempt = vi.fn(async (n: number) => `r${n}`);
    for await (const r of retryAttempts(attempt, { ...o, maxAttempts: 3 })) {
      expect(r).toBe('r0');
      break;
    }
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(o.sleep).not.toHaveBeenCalled();
  });

  it('sleeps delayMs(retry) before each retry and honours maxAttempts', async () => {
    const o = opts();
    const results = await collect(retryAttempts(async (n) => n, { ...o, maxAttempts: 4 }));
    expect(results).toEqual([0, 1, 2, 3]);
    expect(o.sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 300]);
  });

  it('is unbounded by default and only attempts again when pulled', async () => {
    const o = opts();
    const seen: number[] = [];
    for await (const n of retryAttempts(async (i) => i, o)) {
      seen.push(n);
      if (n === 5) break;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    expect(o.sleep).toHaveBeenCalledTimes(5);
  });

  it('propagates an attempt error', async () => {
    const o = opts();
    await expect(collect(retryAttempts(async () => Promise.reject(new Error('nope')), o))).rejects.toThrow('nope');
  });
});

describe('paginate', () => {
  it('follows cursors until none is returned', async () => {
    const pages: Record<string, { page: string[]; next?: string }> = { start: { page: ['a'], next: 'p2' }, p2: { page: ['b', 'c'], next: 'p3' }, p3: { page: [] } };
    const fetchPage = vi.fn(async (cursor: string | undefined) => {
      const p = pages[cursor ?? 'start']!;
      return { page: p.page, next: p.next };
    });
    expect(await collect(paginate(fetchPage))).toEqual([['a'], ['b', 'c'], []]);
    expect(fetchPage.mock.calls.map(([c]) => c)).toEqual([undefined, 'p2', 'p3']);
  });

  it('does not fetch the next page until the previous one is consumed', async () => {
    const fetchPage = vi.fn(async (cursor: number | undefined) => ({ page: cursor ?? 0, next: (cursor ?? 0) < 5 ? (cursor ?? 0) + 1 : undefined }));
    for await (const n of paginate(fetchPage)) {
      expect(fetchPage).toHaveBeenCalledTimes(n + 1);
      if (n === 2) break;
    }
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});

describe('groupBy', () => {
  it('groups by key keeping first-seen group order and per-group item order', () => {
    const groups = groupBy(['a1', 'b1', 'a2', 'c1', 'b2'], (s) => s[0]);
    expect([...groups]).toEqual([['a', ['a1', 'a2']], ['b', ['b1', 'b2']], ['c', ['c1']]]);
  });

  it('returns an empty map for no items', () => {
    expect(groupBy([], (x) => x).size).toBe(0);
  });
});

describe('allSettledOrThrow', () => {
  it('resolves with all values in input order', async () => {
    expect(await allSettledOrThrow([tick().then(() => 1), Promise.resolve(2)])).toEqual([1, 2]);
  });

  it('waits for every promise, then rethrows the first rejection in input order', async () => {
    let slowDone = false;
    const slow = tick().then(() => {
      slowDone = true;
      throw new Error('slow failure');
    });
    const fast = Promise.reject(new Error('fast failure'));
    await expect(allSettledOrThrow([slow, fast])).rejects.toThrow('slow failure');
    expect(slowDone).toBe(true);
  });
});
