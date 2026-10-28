import { BudgetGuard, MemoryItemStore, MemoryJobQueue, MemoryUsageStore, registerUser, type ItemStore } from '@portfolio/platform';
import { FakeAi } from '@portfolio/earnings/testing';
import { parseEarningsConfig } from '@portfolio/earnings';
import { parsePricesConfig } from '@portfolio/prices';
import { classificationKeys, keys, transactionItem, type Transaction } from '@portfolio/shared';
import { describe, expect, it } from 'vitest';
import { createEarningsApi, createEarningsInputs, earningsConfigured, earningsJobDeps, estimatesJobDeps, neuronMeter } from './earnings.js';
import type { HubConfig } from './config.js';

const NOW = new Date('2026-10-21T19:30:00.000Z');
const DAY = '2026-10-21';

const tx = (userId: string, symbol: string, extra: Partial<Transaction> = {}): Transaction => ({ id: `${userId}-${symbol}-${extra.type ?? 'BUY'}-${extra.date ?? 'a'}`, userId, portfolioId: 'p', date: '2025-01-10', type: 'BUY', symbol, quantity: 5, price: 10, fee: 0, currency: 'USD', createdAt: '2025-01-10T00:00:00Z', ...extra });

async function seed(store: ItemStore) {
  for (const user of ['github-1', 'github-2', 'github-3']) await registerUser(store, user, 'x');
  const transactions = [
    tx('github-1', 'LMFG'),
    tx('github-1', 'JPM'),
    tx('github-1', 'VWRL.AS'),
    tx('github-1', 'SOLD'),
    tx('github-1', 'SOLD', { type: 'SELL', date: '2025-02-10' }),
    tx('github-2', 'LMFG'),
    tx('github-2', 'NOPROFILE'),
    tx('github-2', 'JPM'),
    tx('github-2', 'JPM', { type: 'SELL', date: '2025-02-10' }),
    tx('github-2', 'DUST'),
    tx('github-2', 'DUST', { type: 'SELL', date: '2025-02-10', quantity: 5 - 1e-8 }),
    tx('github-3', 'BROKEN', { type: 'SELL', quantity: 99 }),
  ];
  await store.batchWrite(transactions.map((t) => ({ type: 'put' as const, item: transactionItem(t) })));
  const profile = (symbol: string, assetClass: string, extra: Record<string, unknown> = {}) => ({ ...keys.profile(symbol), entityType: 'PROFILE', symbol, name: `${symbol} Inc`, assetClass, currency: 'USD', ...extra });
  await store.batchWrite([
    { type: 'put', item: profile('LMFG', 'STOCK') },
    { type: 'put', item: profile('JPM', 'STOCK', { sector: 'Financial Services' }) },
    { type: 'put', item: profile('VWRL.AS', 'ETF') },
    { type: 'put', item: profile('SOLD', 'STOCK') },
    { type: 'put', item: { ...classificationKeys.override('github-2', 'LMFG'), entityType: 'CLASSIFICATION', userId: 'github-2', symbol: 'LMFG', kpiTemplate: 'saas', createdAt: 'x', updatedAt: 'x' } },
    { type: 'put', item: { PK: 'TICKER#LMFG', SK: 'EARN#2026-10-21', entityType: 'EARNINGS_EVENT', symbol: 'LMFG', date: '2026-10-21', source: 'test' } },
    { type: 'put', item: { PK: 'TICKER#LMFG', SK: 'EARN#2026-01-01', entityType: 'EARNINGS_EVENT', symbol: 'LMFG', date: '2026-01-01', source: 'test' } },
    { type: 'put', item: { PK: 'TICKER#JPM', SK: 'EARN#2027-02-15', entityType: 'EARNINGS_EVENT', symbol: 'JPM', date: '2027-02-15', source: 'test' } },
  ]);
}

describe('createEarningsInputs', () => {
  it('lists the companies held by any user, with template and calendar, and leaves out funds, closed positions and broken users', async () => {
    const store = new MemoryItemStore();
    await seed(store);
    const built = await createEarningsInputs(store).build(DAY, NOW);
    expect(built.holdings).toEqual([
      { symbol: 'JPM', name: 'JPM Inc', template: 'bank', currency: 'USD' },
      { symbol: 'LMFG', name: 'LMFG Inc', template: 'saas', currency: 'USD' },
      { symbol: 'NOPROFILE', name: 'NOPROFILE', template: 'generic' },
    ]);
    expect(built.calendar).toEqual({ JPM: ['2027-02-15'], LMFG: ['2026-10-21'] });
    expect(built.former).toEqual(['DUST', 'SOLD']);
  });

  it('applies the owner\'s classification: an override makes a holding a stock (or a fund), with its name, and the ISIN of the profile is passed on', async () => {
    const store = new MemoryItemStore();
    await registerUser(store, 'github-1', 'x');
    await store.batchWrite(['FOO.DE', 'ETFX.DE', 'M4I.DE', 'ASML.AS'].map((symbol) => ({ type: 'put' as const, item: transactionItem(tx('github-1', symbol)) })));
    const profile = (symbol: string, extra: Record<string, unknown>) => ({ ...keys.profile(symbol), entityType: 'PROFILE', symbol, currency: 'EUR', ...extra });
    const override = (symbol: string, extra: Record<string, unknown>) => ({ ...classificationKeys.override('github-1', symbol), entityType: 'CLASSIFICATION', userId: 'github-1', symbol, createdAt: 'x', updatedAt: 'x', ...extra });
    await store.batchWrite([
      { type: 'put', item: profile('FOO.DE', { name: 'FOO.DE', assetClass: 'OTHER' }) },
      { type: 'put', item: override('FOO.DE', { name: 'Salesforce', assetClass: 'STOCK' }) },
      { type: 'put', item: profile('ETFX.DE', { name: 'Some Company', assetClass: 'STOCK' }) },
      { type: 'put', item: override('ETFX.DE', { assetClass: 'ETF' }) },
      { type: 'put', item: profile('ASML.AS', { name: 'ASML Holding', assetClass: 'STOCK', isin: 'NL0010273215' }) },
    ]);
    const built = await createEarningsInputs(store).build(DAY, NOW);
    expect(built.holdings).toEqual([
      { symbol: 'ASML.AS', name: 'ASML Holding', template: 'generic', currency: 'EUR', isin: 'NL0010273215' },
      { symbol: 'FOO.DE', name: 'Salesforce', template: 'saas', currency: 'EUR' },
      { symbol: 'M4I.DE', name: 'M4I.DE', template: 'generic' },
    ]);
  });

  it('is empty without holdings and reads no calendar then', async () => {
    const store = new MemoryItemStore();
    expect(await createEarningsInputs(store).build(DAY, NOW)).toEqual({ holdings: [], calendar: {}, former: [] });
    await registerUser(store, 'github-1', 'x');
    await store.put(transactionItem(tx('github-1', 'VWRL.AS')));
    await store.put({ ...keys.profile('VWRL.AS'), entityType: 'PROFILE', symbol: 'VWRL.AS', name: 'World', assetClass: 'ETF', currency: 'EUR' });
    expect(await createEarningsInputs(store).build(DAY, NOW)).toEqual({ holdings: [], calendar: {}, former: [] });
  });
});

describe('neuronMeter', () => {
  const guard = (start = '2026-10-21T10:00:00Z') => new BudgetGuard({ store: new MemoryUsageStore(), now: () => new Date(start), flushAfter: 1 });

  it('allows the daily cap of the feature minus what was counted, never more than 80 % of the allowance', async () => {
    const g = guard();
    const meter = neuronMeter(g, 6000);
    expect(await meter.remaining()).toBe(6000);
    await meter.spend(1500);
    expect(await meter.remaining()).toBe(4500);
    expect(await neuronMeter(g, 9000).remaining()).toBe(6500);
    await meter.spend(6600);
    expect(await meter.remaining()).toBe(0);
  });

  it('allows nothing once the guard says blocked', async () => {
    const g = guard();
    await g.record({ aiNeurons: 8000 });
    expect(await neuronMeter(g, 9000).remaining()).toBe(0);
  });
});

describe('earningsJobDeps and createEarningsApi', () => {
  const hubConfig = (env: Record<string, string> = {}): HubConfig => ({ prices: parsePricesConfig({ ALPHAVANTAGE_API_KEY: 'av' }), earnings: parseEarningsConfig(env) }) as HubConfig;
  const context = (config: HubConfig, ai?: FakeAi) => ({
    items: new MemoryItemStore(),
    queue: new MemoryJobQueue({}),
    now: () => NOW,
    config,
    fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
    sleep: () => Promise.resolve(),
    neurons: { remaining: () => Promise.resolve(6000), spend: () => Promise.resolve() },
    ...(ai === undefined ? {} : { ai }),
  });

  it('has a SEC client only with a contact and an extractor only with the AI binding', () => {
    const bare = earningsJobDeps(context(hubConfig()));
    expect([bare.sec, bare.extractor]).toEqual([undefined, undefined]);
    const full = earningsJobDeps(context(hubConfig({ SEC_CONTACT: 'PortfolioTracker/1.0 (me@example.invalid)' }), new FakeAi({})));
    expect([full.sec !== undefined, full.extractor !== undefined, full.estimates !== undefined]).toEqual([true, true, true]);
  });

  it('builds the consensus job with a client only when there is an Alpha Vantage key, through the counted fetch and the shared allowance', async () => {
    const withKey = estimatesJobDeps(context(hubConfig()));
    expect(withKey.client).toBeDefined();
    expect(await withKey.budget.room()).toEqual({ allowed: true, remaining: 25 });
    await expect(withKey.client!.fetchEstimates('AAPL')).resolves.toEqual({ status: 'error', reason: 'the request failed' });
    const noKey = estimatesJobDeps({ ...context(hubConfig()), config: { prices: parsePricesConfig({}), earnings: parseEarningsConfig({}) } as HubConfig });
    expect(noKey.client).toBeUndefined();
  });

  it('is configured only with both', () => {
    const config = hubConfig({ SEC_CONTACT: 'PortfolioTracker/1.0 (me@example.invalid)' });
    expect(earningsConfigured(config, new FakeAi({}))).toBe(true);
    expect(earningsConfigured(config, undefined)).toBe(false);
    expect(earningsConfigured(hubConfig(), new FakeAi({}))).toBe(false);
  });

  it('answers the API with the neurons of the guard', async () => {
    const guard = new BudgetGuard({ store: new MemoryUsageStore(), now: () => NOW, flushAfter: 1 });
    await guard.record({ aiNeurons: 250 });
    const api = createEarningsApi({ items: new MemoryItemStore(), config: hubConfig({ EARNINGS_AI_DAILY_NEURONS: '4000' }), queue: new MemoryJobQueue({}), now: () => NOW, guard });
    expect(await api.status([{ symbol: 'LMFG', eligible: true }])).toMatchObject({
      available: true,
      configured: false,
      missing: ['sec-contact', 'ai-binding'],
      neurons: { used: 250, dailyCap: 4000, allowance: 10_000, state: 'ok', resetsAt: '2026-10-22T00:00:00.000Z' },
    });
  });
});
