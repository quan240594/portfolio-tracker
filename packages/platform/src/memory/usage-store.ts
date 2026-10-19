import { USAGE_COUNTER_METRICS } from '@portfolio/shared';
import type { UsageCounters, UsageDelta, UsageStore } from '../budget/usage-store.js';

const zeroCounters = (): UsageCounters => ({ workerRequests: 0, durableObjectRequests: 0, durableObjectGbSeconds: 0, rowsRead: 0, rowsWritten: 0 });

/** In-memory UsageStore (reference implementation and test double). */
export class MemoryUsageStore implements UsageStore {
  readonly #days = new Map<string, UsageCounters>();

  add(day: string, delta: UsageDelta): Promise<void> {
    const counters = this.#days.get(day) ?? zeroCounters();
    for (const metric of USAGE_COUNTER_METRICS) counters[metric] += delta[metric] ?? 0;
    this.#days.set(day, counters);
    return Promise.resolve();
  }

  read(day: string): Promise<UsageCounters> {
    return Promise.resolve({ ...(this.#days.get(day) ?? zeroCounters()) });
  }

  prune(beforeDay: string): Promise<void> {
    for (const day of this.#days.keys()) if (day < beforeDay) this.#days.delete(day);
    return Promise.resolve();
  }

  /** The days that hold data, oldest first (for assertions). */
  get days(): string[] {
    return [...this.#days.keys()].sort((a, b) => a.localeCompare(b));
  }
}
