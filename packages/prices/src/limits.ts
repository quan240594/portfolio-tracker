import { cond, type ItemKey, type ItemStore } from '@portfolio/platform';
import { retryAttempts } from '@portfolio/shared';
import { RateLimitError } from './errors.js';
import type { Sleep } from './http.js';

/**
 * Client-side rate limiter: `capacity` tokens, refilled continuously at `ratePerSecond`. A wait longer than
 * `maxWaitMs` is not slept (a Durable Object alarm or a Lambda should not idle): it raises a RateLimitError that
 * carries `retryAfterMs`, and the job reschedules itself.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly ratePerSecond: number,
    private readonly clock: () => number,
    private readonly sleep: Sleep,
    private readonly maxWaitMs = Number.POSITIVE_INFINITY,
  ) {
    this.tokens = capacity;
    this.last = clock();
  }

  private refill(): void {
    const now = this.clock();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
    this.last = now;
  }

  /** Waits until `tokens` are available and takes them. Resolves the milliseconds waited. */
  async acquire(tokens = 1, waited = 0): Promise<number> {
    if (tokens > this.capacity) throw new RangeError(`cannot acquire ${tokens} tokens from a bucket of ${this.capacity}`);
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return waited;
    }
    const wait = ((tokens - this.tokens) / this.ratePerSecond) * 1000;
    if (waited + wait > this.maxWaitMs) throw new RateLimitError('client-side rate limit', { retryAfterMs: Math.ceil(wait) });
    await this.sleep(wait);
    return this.acquire(tokens, waited + wait);
  }
}

/**
 * Spends calls of a per-UTC-day budget. `consume` resolves false (and spends nothing) when the call would exceed the
 * limit; a new day starts at zero. Used for the providers' free-tier quotas and for the calendar's rotating budget.
 *
 * A `token` makes a spend idempotent: presenting the same token again the same day spends nothing and resolves true, so a
 * job step that is delivered again after a crash does not pay twice (and is not refused because it paid before).
 */
export interface QuotaLedger {
  consume(key: ItemKey, entityType: string, day: string, calls: number, limit: number, token?: string): Promise<boolean>;
}

const idOf = ({ PK, SK }: ItemKey): string => `${PK}\u0000${SK}`;

/** In-process ledger (tests, one-shot runs). */
export class MemoryQuotaLedger implements QuotaLedger {
  private readonly days = new Map<string, { day: string; used: number; tokens: string[] }>();

  consume(key: ItemKey, _entityType: string, day: string, calls: number, limit: number, token?: string): Promise<boolean> {
    if (calls <= 0) return Promise.resolve(true);
    if (calls > limit) return Promise.resolve(false);
    const state = this.days.get(idOf(key));
    const today = state?.day === day ? state : { day, used: 0, tokens: [] };
    if (token !== undefined && today.tokens.includes(token)) return Promise.resolve(true);
    if (today.used + calls > limit) return Promise.resolve(false);
    this.days.set(idOf(key), { day, used: today.used + calls, tokens: token === undefined ? today.tokens : [...today.tokens, token] });
    return Promise.resolve(true);
  }
}

const MAX_CONTENTION_ATTEMPTS = 5;
const noSleep: Sleep = () => Promise.resolve();

/**
 * Ledger in the item store (`{day, used}` per key, the item shape of the Python service's calendar budget). The spend is a
 * compare-and-set: a conflicting writer makes the loser re-read and try again.
 */
export class StoreQuotaLedger implements QuotaLedger {
  constructor(
    private readonly store: ItemStore,
    private readonly sleep: Sleep = noSleep,
  ) {}

  async consume(key: ItemKey, entityType: string, day: string, calls: number, limit: number, token?: string): Promise<boolean> {
    if (calls <= 0) return true;
    if (calls > limit) return false;
    const attempts = retryAttempts((): Promise<boolean | 'conflict'> => this.spend(key, entityType, day, calls, limit, token), {
      maxAttempts: MAX_CONTENTION_ATTEMPTS,
      delayMs: () => 0,
      sleep: this.sleep,
    });
    for await (const outcome of attempts) if (outcome !== 'conflict') return outcome;
    throw new Error(`Budget ${key.SK} is contended; try again later`);
  }

  private async spend(key: ItemKey, entityType: string, day: string, calls: number, limit: number, token: string | undefined): Promise<boolean | 'conflict'> {
    const current = await this.store.get(key, { consistent: true });
    const sameDay = current?.day === day;
    const used = sameDay ? Number(current.used) : 0;
    const tokens = sameDay && Array.isArray(current.tokens) ? (current.tokens as string[]) : [];
    if (token !== undefined && tokens.includes(token)) return true;
    if (used + calls > limit) return false;
    const guard = current === undefined ? cond.notExists : cond.and(cond.eq('day', String(current.day)), cond.eq('used', Number(current.used)));
    const next = { ...key, entityType, day, used: used + calls, ...(token === undefined ? {} : { tokens: [...tokens, token] }) };
    return (await this.store.put(next, { condition: guard })) ? true : 'conflict';
  }
}

/** The per-provider free-tier quota (calls or credits per UTC day), raising a RateLimitError once it is used up. */
export class DailyQuota {
  constructor(
    private readonly ledger: QuotaLedger,
    readonly provider: string,
    readonly limit: number,
    private readonly today: () => string,
  ) {}

  async consume(units = 1): Promise<void> {
    const key = { PK: 'USAGE', SK: this.provider };
    if (!(await this.ledger.consume(key, 'PROVIDER_USAGE', this.today(), units, this.limit))) {
      throw new RateLimitError(`${this.provider} daily quota of ${this.limit} exhausted`, { provider: this.provider });
    }
  }
}
