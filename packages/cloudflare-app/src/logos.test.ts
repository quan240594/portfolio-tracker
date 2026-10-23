import { BudgetGuard, MemoryUsageStore, METRIC_LIMITS, type Logger } from '@portfolio/platform';
import type { Deps } from '@portfolio/api';
import type { ClassificationOverrideItem, InstrumentProfile } from '@portfolio/shared';
import { describe, expect, it, vi } from 'vitest';
import { createLogoSubjectResolver, logoLookupGate } from './logos.js';

const profile = (extra: Partial<InstrumentProfile>): InstrumentProfile => ({ symbol: 'X', name: 'X', assetClass: 'STOCK', currency: 'EUR', ...extra });
const override = (extra: Partial<ClassificationOverrideItem>): ClassificationOverrideItem => ({ userId: 'u', symbol: 'X', createdAt: '', updatedAt: '', ...extra });

function resolverFor(symbol: string, stored?: InstrumentProfile, overridden?: ClassificationOverrideItem) {
  const deps = {
    repo: { getProfiles: () => Promise.resolve(stored ? { [symbol]: stored } : {}) },
    mgmt: { getClassificationOverrides: () => Promise.resolve(overridden ? { [symbol]: overridden } : {}) },
  } as unknown as Pick<Deps, 'repo' | 'mgmt'>;
  return createLogoSubjectResolver(deps)('u', symbol);
}

describe('createLogoSubjectResolver', () => {
  it('prefers the owner override, then the provider website, then the table, then the ETF issuer', async () => {
    expect(await resolverFor('AAPL', profile({ website: 'provider.example.com' }), override({ domain: 'owner.example.com' }))).toEqual({ domain: 'owner.example.com' });
    expect(await resolverFor('AAPL', profile({ website: 'provider.example.com' }))).toEqual({ domain: 'provider.example.com' });
    expect(await resolverFor('AAPL', profile({}))).toEqual({ domain: 'apple.com' });
    expect(await resolverFor('IWDA.AS', profile({ name: 'iShares Core MSCI World UCITS ETF' }))).toEqual({ domain: 'ishares.com' });
  });

  it('reads the issuer from the name the owner gave it, and knows nothing without a profile or table entry', async () => {
    expect(await resolverFor('FUND.DE', profile({ name: 'Mystery' }), override({ name: 'VanEck Defense UCITS ETF' }))).toEqual({ domain: 'vaneck.com' });
    expect(await resolverFor('ZZZZ')).toBeUndefined();
  });

  it('adds the stored Trading 212 ticker, also for a symbol with no known domain (Salesforce on Xetra)', async () => {
    expect(await resolverFor('FOO.DE', profile({ name: 'Mystery Corp', t212Ticker: 'FOOd_EQ' }))).toEqual({ t212Ticker: 'FOOd_EQ' });
    expect(await resolverFor('AAPL', profile({ t212Ticker: 'AAPL_US_EQ' }))).toEqual({ t212Ticker: 'AAPL_US_EQ', domain: 'apple.com' });
  });

  it('never passes on a stored ticker that is not valid', async () => {
    expect(await resolverFor('AAPL', profile({ t212Ticker: '../x' }))).toEqual({ domain: 'apple.com' });
    expect(await resolverFor('FOO.DE', profile({ name: 'Mystery Corp', t212Ticker: 'a/b' }))).toBeUndefined();
  });

  it('lets an explicit owner domain win over the ticker', async () => {
    expect(await resolverFor('AAPL', profile({ t212Ticker: 'AAPL_US_EQ' }), override({ domain: 'owner.example.com' }))).toEqual({ domain: 'owner.example.com' });
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
