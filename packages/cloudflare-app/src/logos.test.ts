import { BudgetGuard, MemoryUsageStore, METRIC_LIMITS, type Logger } from '@portfolio/platform';
import type { Deps } from '@portfolio/api';
import type { ClassificationOverrideItem, InstrumentProfile } from '@portfolio/shared';
import { describe, expect, it, vi } from 'vitest';
import { createLogoDomainResolver, logoLookupGate } from './logos.js';

const profile = (extra: Partial<InstrumentProfile>): InstrumentProfile => ({ symbol: 'X', name: 'X', assetClass: 'STOCK', currency: 'EUR', ...extra });
const override = (extra: Partial<ClassificationOverrideItem>): ClassificationOverrideItem => ({ userId: 'u', symbol: 'X', createdAt: '', updatedAt: '', ...extra });

function resolverFor(symbol: string, stored?: InstrumentProfile, overridden?: ClassificationOverrideItem) {
  const deps = {
    repo: { getProfiles: () => Promise.resolve(stored ? { [symbol]: stored } : {}) },
    mgmt: { getClassificationOverrides: () => Promise.resolve(overridden ? { [symbol]: overridden } : {}) },
  } as unknown as Pick<Deps, 'repo' | 'mgmt'>;
  return createLogoDomainResolver(deps)('u', symbol);
}

describe('createLogoDomainResolver', () => {
  it('prefers the owner override, then the provider website, then the table, then the ETF issuer', async () => {
    expect(await resolverFor('AAPL', profile({ website: 'provider.example.com' }), override({ domain: 'owner.example.com' }))).toBe('owner.example.com');
    expect(await resolverFor('AAPL', profile({ website: 'provider.example.com' }))).toBe('provider.example.com');
    expect(await resolverFor('AAPL', profile({}))).toBe('apple.com');
    expect(await resolverFor('IWDA.AS', profile({ name: 'iShares Core MSCI World UCITS ETF' }))).toBe('ishares.com');
  });

  it('reads the issuer from the name the owner gave it, and knows nothing without a profile or table entry', async () => {
    expect(await resolverFor('FUND.DE', profile({ name: 'Mystery' }), override({ name: 'VanEck Defense UCITS ETF' }))).toBe('vaneck.com');
    expect(await resolverFor('ZZZZ')).toBeUndefined();
  });
});

describe('logoLookupGate', () => {
  const guard = (limit: number) => new BudgetGuard({ store: new MemoryUsageStore(), limits: { ...METRIC_LIMITS, workerRequests: limit } });

  it('lets a lookup through while the budget is calm', async () => {
    expect(await logoLookupGate(guard(1000))()).toBe(true);
  });

  it('defers a lookup once the budget is in its warning band and says why', async () => {
    const busy = guard(100);
    await busy.record({ workerRequests: 70 });
    const info = vi.fn();
    const logger = { info } as unknown as Logger;
    expect(await logoLookupGate(busy, logger)()).toBe(false);
    expect(info).toHaveBeenCalledWith('Logo lookup deferred by the usage budget', { reason: 'deferred-by-priority' });
    expect(await logoLookupGate(busy)()).toBe(false);
  });
});
