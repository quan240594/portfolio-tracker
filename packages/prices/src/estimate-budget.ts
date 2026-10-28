import type { ItemKey, ItemStore } from '@portfolio/platform';
import { StoreQuotaLedger } from './limits.js';

/** Calls of the Alpha Vantage allowance the consensus job may spend a day (the rest serves the profile enrichment and the earnings calendar). */
export const ESTIMATES_DAILY_CALLS = 8;
/** The job never starts a call when fewer than this many of the provider's daily calls are left. */
export const ESTIMATES_MIN_REMAINING = 5;

const PROVIDER_KEY: ItemKey = { PK: 'USAGE', SK: 'alphavantage' };
const JOB_KEY: ItemKey = { PK: 'USAGE', SK: 'alphavantage#estimates' };
const USAGE_ENTITY = 'PROVIDER_USAGE';

export interface EstimateBudgetOptions {
  store: ItemStore;
  /** The provider's calls a day (25 on the free plan): the reserve is checked against it. */
  dailyLimit: number;
  /** What the app's general calls may use of it: the calendar's own call is kept apart (`alphaVantageGeneralLimit`). */
  generalLimit: number;
  /** The job's own cap a day. */
  jobLimit?: number;
  minRemaining?: number;
  /** The UTC day (YYYY-MM-DD). */
  today: () => string;
}

export type EstimateRoom = { allowed: true; remaining: number } | { allowed: false; reason: 'job-cap' | 'low-allowance' };

/**
 * The allowance of the consensus job: at most `jobLimit` calls a day of its own counter (`USAGE/alphavantage#estimates`), each one also
 * counted in the provider's shared counter (`USAGE/alphavantage`, the one enrichment and the calendar use), and none when fewer than
 * `minRemaining` of the provider's calls are left. Both counters are per UTC day and persisted, so every job step sees what earlier ones spent.
 */
export class EstimateBudget {
  private readonly ledger: StoreQuotaLedger;

  constructor(private readonly options: EstimateBudgetOptions) {
    this.ledger = new StoreQuotaLedger(options.store);
  }

  private get jobLimit(): number {
    return this.options.jobLimit ?? ESTIMATES_DAILY_CALLS;
  }

  private get minRemaining(): number {
    return this.options.minRemaining ?? ESTIMATES_MIN_REMAINING;
  }

  /** Whether a call may be made now. */
  async room(): Promise<EstimateRoom> {
    const found = await this.options.store.getMany([PROVIDER_KEY, JOB_KEY]);
    const day = this.options.today();
    const usedOf = (key: ItemKey): number => {
      const item = found.find((candidate) => candidate.PK === key.PK && candidate.SK === key.SK);
      return item?.day === day && typeof item.used === 'number' ? item.used : 0;
    };
    if (usedOf(JOB_KEY) >= this.jobLimit) return { allowed: false, reason: 'job-cap' };
    const remaining = this.options.dailyLimit - usedOf(PROVIDER_KEY);
    return remaining < this.minRemaining ? { allowed: false, reason: 'low-allowance' } : { allowed: true, remaining };
  }

  /** Spends one call from both counters; false (nothing kept) when either is used up. */
  async spend(): Promise<boolean> {
    const day = this.options.today();
    if (!(await this.ledger.consume(JOB_KEY, USAGE_ENTITY, day, 1, this.jobLimit))) return false;
    return this.ledger.consume(PROVIDER_KEY, USAGE_ENTITY, day, 1, this.options.generalLimit);
  }
}
