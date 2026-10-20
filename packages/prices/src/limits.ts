import { cond, type ItemKey, type ItemStore } from '@portfolio/platform';
import { retryAttempts } from '@portfolio/shared';
import { RateLimitError, type LimitScope } from './errors.js';
import { asText } from './parse.js';
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
    const guard = current === undefined ? cond.notExists : cond.and(cond.eq('day', asText(current.day)), cond.eq('used', Number(current.used)));
    const next = { ...key, entityType, day, used: used + calls, ...(token === undefined ? {} : { tokens: [...tokens, token] }) };
    return (await this.store.put(next, { condition: guard })) ? true : 'conflict';
  }
}

/** A quota is trusted again this long after its nominal reset, so a clock that runs a little ahead of the provider's does not hit the limit again. */
export const RESET_MARGIN_MS = 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The instant after the UTC day `day` (`YYYY-MM-DD`) ends. */
export const endOfUtcDay = (day: string): number => Date.parse(`${day}T00:00:00Z`) + DAY_MS;

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
    const day = this.today();
    if (!(await this.ledger.consume(key, 'PROVIDER_USAGE', day, units, this.limit))) {
      throw new RateLimitError(`${this.provider} daily quota of ${this.limit} exhausted`, { provider: this.provider, scope: 'day', resetAtMs: endOfUtcDay(day) + RESET_MARGIN_MS });
    }
  }
}

/**
 * The per-minute credits of a provider (Twelve Data: 8), persisted like the daily quota. A job step builds its providers anew,
 * so an in-memory token bucket would start every step with full credits; this ledger remembers what the previous steps spent.
 */
export class MinuteQuota {
  constructor(
    private readonly ledger: QuotaLedger,
    readonly provider: string,
    readonly limit: number,
    private readonly now: () => number,
  ) {}

  async consume(units = 1): Promise<void> {
    const key = { PK: 'USAGE', SK: `${this.provider}#minute` };
    const minute = Math.floor(this.now() / MINUTE_MS);
    if (!(await this.ledger.consume(key, 'PROVIDER_USAGE', new Date(minute * MINUTE_MS).toISOString().slice(0, 16), units, this.limit))) {
      throw new RateLimitError(`${this.provider} credits of this minute (${this.limit}) are used`, { provider: this.provider, scope: 'minute', resetAtMs: (minute + 1) * MINUTE_MS + 1000 });
    }
  }
}

/** When a quota of `scope` that ran out at `nowMs` is available again. */
export const resetOf = (scope: LimitScope, nowMs: number): number =>
  scope === 'day' ? endOfUtcDay(new Date(nowMs).toISOString().slice(0, 10)) + RESET_MARGIN_MS : (Math.floor(nowMs / MINUTE_MS) + 1) * MINUTE_MS + 1000;

export const BLOCK_ENTITY = 'PROVIDER_BLOCK';
export const blockKey = (provider: string): ItemKey => ({ PK: 'USAGE', SK: `BLOCK#${provider}` });
const MAX_REASON_CHARS = 200;

/** A provider that said "limit reached": nothing is asked of it before `until` (epoch milliseconds). */
export interface ProviderBlock {
  until: number;
  scope?: LimitScope;
}

/** The persisted blocks (`USAGE/BLOCK#{provider}`), shared by every job step: a block written once saves every later call. */
export class BlockBook {
  constructor(
    private readonly store: ItemStore,
    private readonly clock: () => Date,
  ) {}

  /** The blocks still in force among `providers`. */
  async active(providers: readonly string[]): Promise<Map<string, ProviderBlock>> {
    const items = await this.store.getMany(providers.map(blockKey));
    const nowMs = this.clock().getTime();
    const out = new Map<string, ProviderBlock>();
    for (const item of items) {
      const until = typeof item.until === 'number' ? item.until : 0;
      if (until > nowMs) out.set(item.SK.slice('BLOCK#'.length), { until, ...(item.scope === 'minute' || item.scope === 'day' ? { scope: item.scope } : {}) });
    }
    return out;
  }

  /** Records a block unless a longer one is stored. */
  async block(provider: string, until: number, scope: LimitScope | undefined, reason: string): Promise<void> {
    const current = (await this.active([provider])).get(provider);
    if (current !== undefined && current.until >= until) return;
    await this.store.put({ ...blockKey(provider), entityType: BLOCK_ENTITY, provider, until, ...(scope === undefined ? {} : { scope }), reason: reason.slice(0, MAX_REASON_CHARS), setAt: this.clock().toISOString() });
  }
}

/** The check in front of every call of one provider: blocked means a RateLimitError at once, with no request and no quota spent. */
export class ProviderGate {
  private known: ProviderBlock | undefined;
  private loaded = false;

  constructor(
    private readonly book: BlockBook,
    readonly provider: string,
    private readonly clock: () => Date,
  ) {}

  async assertOpen(): Promise<void> {
    if (!this.loaded) {
      this.known = (await this.book.active([this.provider])).get(this.provider);
      this.loaded = true;
    }
    if (this.known !== undefined && this.known.until > this.clock().getTime()) {
      throw new RateLimitError(`${this.provider} is limited until ${new Date(this.known.until).toISOString()}`, { provider: this.provider, scope: this.known.scope, resetAtMs: this.known.until });
    }
  }

  /** The provider (or the ledger) says its quota is used up until `until`. */
  async block(until: number, scope: LimitScope, reason: string): Promise<void> {
    this.known = { until, scope };
    this.loaded = true;
    await this.book.block(this.provider, until, scope, reason);
  }
}

export interface ProviderLimits {
  quota: DailyQuota;
  minuteQuota?: MinuteQuota;
  gate?: ProviderGate;
}

/** Asks the gate, then spends the per-minute and the daily credits. A daily quota that ran out blocks the provider until its reset. */
export async function spendCredits({ quota, minuteQuota, gate }: ProviderLimits, credits: number): Promise<void> {
  await gate?.assertOpen();
  await minuteQuota?.consume(credits);
  try {
    await quota.consume(credits);
  } catch (error) {
    if (error instanceof RateLimitError && gate !== undefined && error.resetAtMs !== undefined) await gate.block(error.resetAtMs, 'day', error.message);
    throw error;
  }
}

export const PLAN_ENTITY = 'PROVIDER_PLAN';
/** A plan that lacks an endpoint is asked again after this long (the owner may have upgraded). */
export const PLAN_RECHECK_MS = 7 * DAY_MS;

/** `PlanMemory` in the item store (`USAGE/PLAN#{provider}`). */
export class StorePlanMemory {
  constructor(
    private readonly store: ItemStore,
    private readonly provider: string,
    private readonly clock: () => Date,
  ) {}

  private get key(): ItemKey {
    return { PK: 'USAGE', SK: `PLAN#${this.provider}` };
  }

  async profileUnsupported(): Promise<boolean> {
    const item = await this.store.get(this.key);
    return typeof item?.profileUnsupportedUntil === 'number' && item.profileUnsupportedUntil > this.clock().getTime();
  }

  async markProfileUnsupported(): Promise<void> {
    const now = this.clock();
    await this.store.update(this.key, { set: { entityType: PLAN_ENTITY, provider: this.provider, profileUnsupportedUntil: now.getTime() + PLAN_RECHECK_MS, checkedAt: now.toISOString() } });
  }
}
