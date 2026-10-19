import { vi } from 'vitest';
import type { UsageCounters, UsageDelta, UsageStore } from '../budget/usage-store.js';
import type { Logger } from '../logger.js';
import { MemoryUsageStore } from '../memory/usage-store.js';

export const at = (iso: string) => new Date(iso);

/** A clock tests can move. */
export function clock(start: string) {
  let current = at(start).getTime();
  return {
    now: () => new Date(current),
    set: (iso: string) => {
      current = at(iso).getTime();
    },
  };
}

export function spyLogger() {
  const warn = vi.fn();
  const info = vi.fn();
  const logger = { warn, info, debug: vi.fn(), error: vi.fn(), appendKeys: vi.fn(), removeKeys: vi.fn(), createChild: vi.fn() } as unknown as Logger;
  return { logger, warn, info };
}

/** A store whose operations can be switched to fail. */
export class FlakyStore implements UsageStore {
  readonly inner = new MemoryUsageStore();
  failing = false;
  failPrune = false;
  adds = 0;
  add(day: string, delta: UsageDelta): Promise<void> {
    this.adds += 1;
    return this.failing ? Promise.reject(new Error('store down')) : this.inner.add(day, delta);
  }
  read(day: string): Promise<UsageCounters> {
    return this.failing ? Promise.reject(new Error('store down')) : this.inner.read(day);
  }
  prune(beforeDay: string): Promise<void> {
    return this.failPrune ? Promise.reject(new Error('prune failed')) : this.inner.prune(beforeDay);
  }
}
