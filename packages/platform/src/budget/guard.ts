import { USAGE_COUNTER_METRICS, USAGE_METRICS, type UsageMetric, type UsageMetricSnapshot, type UsageSnapshot, type UsageState } from '@portfolio/shared';
import { logger as defaultLogger, type Logger } from '../logger.js';
import { BUDGET_THRESHOLDS, METRIC_LIMITS, classifyUsage, isCounterMetric, nextUtcMidnight, secondsUntilReset, usagePercent, utcDay, utcDayBefore, type MetricLimits } from './limits.js';
import type { UsageCounters, UsageDelta, UsageStore } from './usage-store.js';

/** What a unit of work is, for the fail-closed rule: reads stay possible when the ledger is unreadable, the rest does not. */
export type WorkKind = 'read' | 'write' | 'job';

export interface BudgetDecision {
  allowed: boolean;
  /** `unavailable` when the ledger could not be read (the guard then allows only reads). */
  state: UsageState;
  /** The metrics at or above the block threshold. */
  blockedMetrics: UsageMetric[];
  /** Seconds until a retry can succeed: the next 00:00 UTC, an hour for a storage-only block, a minute when the ledger is unavailable. */
  retryAfterSeconds: number;
}

export interface BudgetGuardOptions {
  store: UsageStore;
  /** Injected clock; defaults to the system clock. */
  now?: () => Date;
  /** Receives the state-change warnings; defaults to the application logger. */
  logger?: Logger;
  /** Caps to measure against; defaults to the Free-plan table (`METRIC_LIMITS`). */
  limits?: MetricLimits;
  /** Current size of the database in bytes (the gauge). Without it the storage metric stays at 0. */
  readStorageBytes?: () => number | Promise<number>;
  /** Writes to the store after this many `record` calls (default 1 = write-through). Each flush costs one row written, so the Durable Object wiring batches (e.g. 20) and calls `flush()` at the end of every alarm. */
  flushAfter?: number;
  /** Days of history kept in the store (default 7); older days are pruned when a new day starts. */
  retainDays?: number;
}

const UNAVAILABLE_RETRY_SECONDS = 60;
const STORAGE_RETRY_SECONDS = 3600;
const DEFAULT_RETAIN_DAYS = 7;

const zeroCounters = (): UsageCounters => ({ workerRequests: 0, durableObjectRequests: 0, durableObjectGbSeconds: 0, rowsRead: 0, rowsWritten: 0 });

/** Keeps only finite, positive amounts of known counters. */
function sanitize(delta: UsageDelta): UsageDelta {
  const clean: UsageDelta = {};
  for (const metric of USAGE_COUNTER_METRICS) {
    const amount = delta[metric];
    if (amount !== undefined && Number.isFinite(amount) && amount > 0) clean[metric] = amount;
  }
  return clean;
}

function addInto(target: UsageCounters, delta: UsageDelta): void {
  for (const metric of USAGE_COUNTER_METRICS) target[metric] += delta[metric] ?? 0;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Evaluation {
  day: string;
  now: Date;
  available: boolean;
  state: UsageState;
  metrics: Record<UsageMetric, UsageMetricSnapshot>;
  blockedMetrics: UsageMetric[];
}

/**
 * Keeps the deployment under the Free-plan caps: counts usage per UTC day in a `UsageStore` and answers whether more
 * work may run. A metric is `ok` below 60 % of its cap, `warn` from 60 % and `blocked` from 80 %; the overall state is
 * the worst one. Fails closed: when the store cannot be read, jobs and writes are refused and only reads run.
 *
 * Pure apart from the injected store, clock and logger. `record` and `flush` never reject.
 */
export class BudgetGuard {
  readonly #store: UsageStore;
  readonly #now: () => Date;
  readonly #logger: Logger;
  readonly #limits: MetricLimits;
  readonly #readStorageBytes: () => number | Promise<number>;
  readonly #flushAfter: number;
  readonly #retainDays: number;
  readonly #pending = new Map<string, UsageCounters>();
  #unflushed = 0;
  #prunedUpTo = '';
  #lastState: UsageState = 'ok';
  #flushFailing = false;

  constructor(options: BudgetGuardOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? defaultLogger;
    this.#limits = options.limits ?? METRIC_LIMITS;
    this.#readStorageBytes = options.readStorageBytes ?? (() => 0);
    this.#flushAfter = Math.max(1, Math.floor(options.flushAfter ?? 1));
    this.#retainDays = Math.max(1, Math.floor(options.retainDays ?? DEFAULT_RETAIN_DAYS));
  }

  /** Adds usage to today's counters. Invalid amounts (negative, NaN, infinite) are ignored. */
  async record(delta: UsageDelta): Promise<void> {
    const clean = sanitize(delta);
    if (Object.keys(clean).length === 0) return;
    const day = utcDay(this.#now());
    const counters = this.#pending.get(day) ?? zeroCounters();
    addInto(counters, clean);
    this.#pending.set(day, counters);
    this.#unflushed += 1;
    if (this.#unflushed >= this.#flushAfter) await this.flush();
  }

  /** Row counts of a database operation; the `onUsage` callback of the Durable Object adapters calls this. */
  recordRows(rows: { read?: number; written?: number }): Promise<void> {
    return this.record({ rowsRead: rows.read, rowsWritten: rows.written });
  }

  /** Writes the buffered usage to the store. A failure keeps it buffered for the next flush. */
  async flush(): Promise<void> {
    const batch = [...this.#pending];
    this.#pending.clear();
    this.#unflushed = 0;
    if (batch.length === 0) return;
    let failure: unknown;
    await Promise.all(
      batch.map(async ([day, counters]) => {
        try {
          await this.#store.add(day, counters);
        } catch (error) {
          failure = error;
          this.#restore(day, counters);
        }
      }),
    );
    this.#noteFlush(failure);
    if (failure === undefined) await this.#prune(utcDay(this.#now()));
  }

  /** May one unit of `kind` run now? Counts nothing: call `record` for the work that does run. */
  async check(kind: WorkKind): Promise<BudgetDecision> {
    const evaluation = await this.#evaluate();
    const allowed = evaluation.available ? evaluation.state !== 'blocked' : kind === 'read';
    return { allowed, state: evaluation.state, blockedMetrics: evaluation.blockedMetrics, retryAfterSeconds: this.#retryAfter(evaluation) };
  }

  /** Usage of today against every cap: the payload of `GET /usage`. Never rejects. */
  async snapshot(): Promise<UsageSnapshot> {
    const evaluation = await this.#evaluate();
    return {
      day: evaluation.day,
      generatedAt: evaluation.now.toISOString(),
      resetsAt: nextUtcMidnight(evaluation.now).toISOString(),
      state: evaluation.state,
      thresholds: { ...BUDGET_THRESHOLDS },
      metrics: evaluation.metrics,
    };
  }

  #restore(day: string, counters: UsageCounters): void {
    const existing = this.#pending.get(day) ?? zeroCounters();
    addInto(existing, counters);
    this.#pending.set(day, existing);
    this.#unflushed += 1;
  }

  #noteFlush(failure: unknown): void {
    if (failure !== undefined && !this.#flushFailing) {
      this.#logger.warn('Budget guard could not write usage; keeping it in memory', { error: errorMessage(failure) });
    }
    this.#flushFailing = failure !== undefined;
  }

  async #prune(day: string): Promise<void> {
    if (day <= this.#prunedUpTo) return;
    this.#prunedUpTo = day;
    try {
      await this.#store.prune(utcDayBefore(day, this.#retainDays));
    } catch (error) {
      this.#logger.warn('Budget guard could not prune old usage', { error: errorMessage(error) });
    }
  }

  #retryAfter(evaluation: Evaluation): number {
    if (!evaluation.available) return UNAVAILABLE_RETRY_SECONDS;
    if (evaluation.blockedMetrics.length > 0 && !evaluation.blockedMetrics.some((metric) => isCounterMetric(metric))) return STORAGE_RETRY_SECONDS;
    return secondsUntilReset(evaluation.now);
  }

  async #readStorage(): Promise<number> {
    const bytes = await this.#readStorageBytes();
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid storage reading');
    return bytes;
  }

  async #evaluate(): Promise<Evaluation> {
    const now = this.#now();
    const day = utcDay(now);
    let stored = zeroCounters();
    let storageBytes = 0;
    let available = true;
    try {
      [stored, storageBytes] = await Promise.all([this.#store.read(day), this.#readStorage()]);
    } catch (error) {
      available = false;
      this.#reportState('unavailable', [], errorMessage(error));
    }
    stored = { ...stored };
    addInto(stored, this.#pending.get(day) ?? {});
    const used: Record<UsageMetric, number> = { ...stored, storageBytes };
    const metrics = {} as Record<UsageMetric, UsageMetricSnapshot>;
    const blockedMetrics: UsageMetric[] = [];
    let state: UsageState = 'ok';
    for (const metric of USAGE_METRICS) {
      const limit = this.#limits[metric];
      const metricState = classifyUsage(used[metric], limit);
      metrics[metric] = { used: used[metric], limit, percent: usagePercent(used[metric], limit), state: metricState };
      if (metricState === 'blocked') blockedMetrics.push(metric);
      if (metricState === 'blocked' || (metricState === 'warn' && state === 'ok')) state = metricState;
    }
    if (available) this.#reportState(state, blockedMetrics);
    return { day, now, available, state: available ? state : 'unavailable', metrics, blockedMetrics };
  }

  #reportState(state: UsageState, blockedMetrics: UsageMetric[], error?: string): void {
    if (state === this.#lastState) return;
    this.#lastState = state;
    const fields = { state, blockedMetrics, ...(error === undefined ? {} : { error }) };
    if (state === 'ok') this.#logger.info('Budget guard back under the warning threshold', fields);
    else this.#logger.warn(`Budget guard state is ${state}`, fields);
  }
}
