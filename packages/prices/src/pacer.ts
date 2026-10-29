import type { FetchLike, Sleep } from './http.js';

/** Alpha Vantage refuses a "burst": its free key is limited per second as well as per day, so two requests are never sent closer than this. */
export const ALPHAVANTAGE_MIN_GAP_MS = 1500;

export interface ProviderPacerOptions {
  /** The least time between the starts of two requests to the same provider. */
  minGapMs: number;
  /** Epoch milliseconds. */
  now: () => number;
  sleep: Sleep;
}

/**
 * Keeps requests to one provider at least `minGapMs` apart, however many callers there are in the process. A caller reserves the next free
 * slot synchronously, so concurrent callers queue behind each other, and then sleeps until its slot starts. The wait is wall time, not CPU
 * (a Durable Object alarm may sleep: the timer costs no CPU), and is at most one gap per queued caller, so a step that makes a few calls stays
 * well inside its limits. State is in memory: a fresh process starts with no wait, which is right since nothing was sent before it.
 */
export class ProviderPacer {
  private readonly nextFree = new Map<string, number>();

  constructor(private readonly options: Readonly<ProviderPacerOptions>) {}

  /** Resolves when a request to `provider` may start; the milliseconds waited. */
  async wait(provider: string): Promise<number> {
    const now = this.options.now();
    const start = Math.max(now, this.nextFree.get(provider) ?? 0);
    this.nextFree.set(provider, start + this.options.minGapMs);
    const wait = start - now;
    if (wait > 0) await this.options.sleep(wait);
    return wait;
  }
}

/** A `fetch` that waits for the provider's next slot before it sends. */
export function pacedFetch(inner: FetchLike, pacer: Pick<ProviderPacer, 'wait'>, provider: string): FetchLike {
  return async (url, init) => {
    await pacer.wait(provider);
    return inner(url, init);
  };
}
