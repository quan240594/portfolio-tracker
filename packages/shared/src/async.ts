/**
 * Small async-iteration helpers for work that is inherently sequential (paging, retries, ordered processing).
 * Consumers use `for await…of`, which makes the one-at-a-time intent explicit and keeps `await` out of loop bodies.
 */

/**
 * Runs `task` for each item (sync or async source) strictly one after another, yielding each result.
 * Stops (and rejects) at the first failure.
 */
export async function* sequentially<T, R>(
  items: Iterable<T> | AsyncIterable<T>,
  task: (item: T) => Promise<R>,
): AsyncGenerator<R, void, undefined> {
  // `yield` awaits the promise before the next item is pulled, so tasks never overlap.
  for await (const item of items) yield task(item);
}

/** Consumes an async iterable purely for its side effects. */
export async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iterable) {
    // results are intentionally ignored
  }
}

export interface RetryOptions {
  /** Maximum number of attempts; unbounded when omitted. */
  maxAttempts?: number;
  /** Delay before attempt number `attempt` (1-based retry index; the first attempt is never delayed). */
  delayMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Lazily performs `attempt`, yielding each outcome. The consumer decides whether to stop (break/return) or keep
 * going; before every retry the generator sleeps for `delayMs(retryIndex)`. `attempt` receives the 0-based attempt number.
 */
export async function* retryAttempts<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  { maxAttempts = Number.POSITIVE_INFINITY, delayMs, sleep }: RetryOptions,
): AsyncGenerator<T, void, undefined> {
  for (let n = 0; n < maxAttempts; n++) {
    if (n > 0) await sleep(delayMs(n));
    yield await attempt(n);
  }
}

/** Yields successive pages: `fetchPage(cursor)` returns the page and the cursor of the next one (undefined when done). */
export async function* paginate<P, C>(
  fetchPage: (cursor: C | undefined) => Promise<{ page: P; next: C | undefined }>,
): AsyncGenerator<P, void, undefined> {
  let cursor: C | undefined;
  do {
    const { page, next } = await fetchPage(cursor);
    yield page;
    cursor = next;
  } while (cursor !== undefined);
}

/** Groups items by key, preserving the original order within every group. */
export function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** Awaits all promises, then rethrows the first rejection in input order (so no work is left running in the background). */
export async function allSettledOrThrow<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}
