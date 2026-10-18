import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { MANAGEMENT_ROUTES, MAX_CATEGORIES, MAX_CUSTOM_ASSETS, MAX_VALUATIONS, MAX_WATCHLIST } from '@portfolio/shared';
import { createHandler } from './lambda/handler.js';
import { matchRoute } from './router.js';
import { toResponse } from './lib/http.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body && res.headers?.['content-type'] === 'application/json' ? JSON.parse(res.body) : undefined);
const NOW = '2026-06-15T12:00:00.000Z';

/** `default`: EUR ETF + USD AAPL; `broker`: nothing but a USD MSFT. Latest USD rate 1.1. */
function setup() {
  const ctx = fakeDeps();
  const { repo } = ctx;
  repo.portfolios = [
    portfolio({ portfolioId: 'default', name: 'Main portfolio' }),
    portfolio({ portfolioId: 'broker', name: 'Broker', createdAt: '2025-02-01T00:00:00.000Z' }),
    portfolio({ portfolioId: 'default', userId: 'someone-else', name: 'Other main' }),
  ];
  repo.transactions = [
    txn({ id: 't1', date: '2025-01-10', type: 'BUY', symbol: 'VWRL.AS', quantity: 10, price: 100 }),
    txn({ id: 't2', date: '2025-03-03', type: 'BUY', symbol: 'AAPL', quantity: 5, price: 150, currency: 'USD' }),
    txn({ id: 'b1', portfolioId: 'broker', date: '2025-05-02', type: 'BUY', symbol: 'MSFT', quantity: 2, price: 400, currency: 'USD' }),
  ];
  repo.quotes = {
    'VWRL.AS': { symbol: 'VWRL.AS', price: 120, previousClose: 118, currency: 'EUR', asOf: NOW, source: 'test' },
    AAPL: { symbol: 'AAPL', price: 220, previousClose: 215, currency: 'USD', asOf: NOW, source: 'test' },
    MSFT: { symbol: 'MSFT', price: 440, previousClose: 440, currency: 'USD', asOf: NOW, source: 'test' },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.1 }, asOf: NOW };
  const handler = createHandler(() => ctx.deps);
  const call = async (method: string, path: string, opts: { query?: Record<string, string>; body?: unknown; sub?: string } = {}) => {
    const res = await handler(apiEvent(method, path, opts));
    return { status: res.statusCode, body: json(res), res };
  };
  return { ...ctx, handler, call };
}
type Setup = ReturnType<typeof setup>;

const settingsOn = (s: Setup, portfolioId = 'default') => s.call('PUT', `/portfolios/${portfolioId}/settings`, { body: { trackCash: true } });
const addCategory = async (s: Setup, name: string, targetWeight: number, symbols: string[] = [], portfolioId = 'default') => {
  const created = await s.call('POST', `/portfolios/${portfolioId}/categories`, { body: { name, color: '#336699', targetWeight } });
  if (symbols.length) await s.call('PUT', `/portfolios/${portfolioId}/categories/${created.body.categoryId}/holdings`, { body: { symbols } });
  return created;
};

describe('routing', () => {
  it('matches every management route', () => {
    for (const [name, spec] of Object.entries(MANAGEMENT_ROUTES)) {
      const [method, path] = spec.split(' ') as [string, string];
      const m = matchRoute(method, path.replace('{id}', 'p1').replace('{cid}', 'c1').replace('{aid}', 'a1').replace('{date}', '2026-01-01').replace('{symbol}', 'NVDA'));
      expect(m.name).toBe(name);
    }
  });

  it('decodes encoded watchlist symbols', () => {
    expect(matchRoute('DELETE', '/watchlist/%5EGSPC').pathParams).toEqual({ symbol: '^GSPC' });
  });
});

describe('response serialisation', () => {
  it('sends string bodies as-is when a content type is given and merges extra headers', () => {
    const res = toResponse({ statusCode: 200, body: 'a,b\n', contentType: 'text/csv', headers: { 'content-disposition': 'attachment' } }, '*');
    expect(res.body).toBe('a,b\n');
    expect(res.headers).toMatchObject({ 'content-type': 'text/csv', 'content-disposition': 'attachment' });
    expect(toResponse({ statusCode: 200, body: 'x' }, '*').body).toBe('"x"');
  });
});

describe('portfolio settings', () => {
  it('defaults to cash tracking off and stores updates per portfolio and user', async () => {
    const s = setup();
    const initial = await s.call('GET', '/portfolios/default/settings');
    expect(initial.body).toMatchObject({ portfolioId: 'default', userId: 'demo', trackCash: false });
    expect(initial.body.withholdingTaxRate).toBeUndefined();

    const updated = await s.call('PUT', '/portfolios/default/settings', { body: { trackCash: true, withholdingTaxRate: 15 } });
    expect(updated).toMatchObject({ status: 200, body: { trackCash: true, withholdingTaxRate: 15, updatedAt: NOW } });
    expect((await s.call('GET', '/portfolios/default/settings')).body.withholdingTaxRate).toBe(15);
    expect((await s.call('GET', '/portfolios/broker/settings')).body.trackCash).toBe(false);
    expect((await s.call('GET', '/portfolios/default/settings', { sub: 'someone-else' })).body.trackCash).toBe(false);

    const cleared = await s.call('PUT', '/portfolios/default/settings', { body: { trackCash: false, withholdingTaxRate: null } });
    expect(cleared.body.withholdingTaxRate).toBeUndefined();
  });

  it('validates the body and the portfolio', async () => {
    const s = setup();
    expect((await s.call('PUT', '/portfolios/default/settings', { body: { trackCash: 'yes' } })).status).toBe(400);
    expect((await s.call('PUT', '/portfolios/default/settings', { body: { trackCash: true, withholdingTaxRate: 101 } })).status).toBe(400);
    expect((await s.call('PUT', '/portfolios/default/settings')).status).toBe(400);
    expect((await s.call('GET', '/portfolios/nope/settings')).status).toBe(404);
    expect((await s.call('GET', '/portfolios/BAD_ID/settings')).status).toBe(404);
  });
});

describe('transactions of the management types', () => {
  it('books deposits without registering a ticker or publishing an event', async () => {
    const s = setup();
    const res = await s.call('POST', '/transactions', {
      body: { portfolioId: 'default', date: '2026-01-02', type: 'DEPOSIT', symbol: 'cash.eur', quantity: 1000, price: 1, currency: 'EUR' },
    });
    expect(res).toMatchObject({ status: 201, body: { type: 'DEPOSIT', symbol: 'CASH.EUR' } });
    expect(s.repo.tracked.has('CASH.EUR')).toBe(false);
    expect(s.events.published).toEqual([]);
  });

  it('validates cash movements and splits like other transactions', async () => {
    const s = setup();
    const base = { portfolioId: 'default', date: '2026-01-02', quantity: 2, price: 0, currency: 'EUR' };
    expect((await s.call('POST', '/transactions', { body: { ...base, type: 'DEPOSIT', symbol: 'AAPL' } })).status).toBe(400);
    expect((await s.call('POST', '/transactions', { body: { ...base, type: 'SPLIT', symbol: 'ZZZ' } })).status).toBe(422); // no position
    const ok = await s.call('POST', '/transactions', { body: { ...base, type: 'SPLIT', symbol: 'VWRL.AS' } });
    expect(ok.status).toBe(201);
    expect(s.events.published).toEqual([{ userId: 'demo', portfolioId: 'default', symbols: ['VWRL.AS'], reason: 'CREATED' }]);

    // A SELL that only fits after the split is accepted; deleting the split makes it an oversell again
    const sell = await s.call('POST', '/transactions', { body: { portfolioId: 'default', date: '2026-02-01', type: 'SELL', symbol: 'VWRL.AS', quantity: 20, price: 60, currency: 'EUR' } });
    expect(sell.status).toBe(201);
    expect((await s.call('DELETE', `/transactions/${ok.body.id}`)).status).toBe(422);
  });

  it('applies a split to holdings', async () => {
    const s = setup();
    s.repo.transactions.push(txn({ id: 'split', date: '2025-06-01', type: 'SPLIT', symbol: 'VWRL.AS', quantity: 2, price: 0 }));
    const { body } = await s.call('GET', '/holdings', { query: { portfolioId: 'default' } });
    expect(body.holdings.find((h: { symbol: string }) => h.symbol === 'VWRL.AS')).toMatchObject({ quantity: 20, averageCostLocal: 50, costBasis: 1000, marketValue: 2400 });
  });
});

describe('cash tracking in the read endpoints', () => {
  const deposit = (s: Setup, extra: object = {}) =>
    s.repo.transactions.push(txn({ id: 'dep', date: '2025-01-01', type: 'DEPOSIT', symbol: 'CASH.EUR', quantity: 5000, price: 1, ...extra }));

  it('ignores cash movements while tracking is off', async () => {
    const s = setup();
    deposit(s);
    const { body } = await s.call('GET', '/portfolio', { query: { portfolioId: 'default' } });
    expect(body.totalValue).toBe(2200);
    expect(body.cashValue).toBeUndefined();
    const holdings = (await s.call('GET', '/holdings', { query: { portfolioId: 'default' } })).body.holdings;
    expect(holdings.map((h: { symbol: string }) => h.symbol)).toEqual(['VWRL.AS', 'AAPL']);
  });

  it('shows the cash balance in summary, holdings and allocation when tracking is on', async () => {
    const s = setup();
    deposit(s);
    await settingsOn(s);
    const summary = (await s.call('GET', '/portfolio', { query: { portfolioId: 'default' } })).body;
    // EUR: 5000 - 1000 (VWRL) = 4000; USD: -750 -> -681.82 EUR
    expect(summary).toMatchObject({ cashValue: 3318.18, totalValue: 5518.18, holdingsCount: 4 });
    const holdings = (await s.call('GET', '/holdings', { query: { portfolioId: 'default' } })).body.holdings;
    expect(holdings.map((h: { symbol: string; marketValue: number }) => [h.symbol, h.marketValue])).toEqual([
      ['CASH.EUR', 4000],
      ['VWRL.AS', 1200],
      ['AAPL', 1000],
      ['CASH.USD', -681.82],
    ]);
    const allocation = (await s.call('GET', '/allocation', { query: { portfolioId: 'default', by: 'assetClass' } })).body;
    expect(allocation.slices.find((x: { key: string }) => x.key === 'CASH')).toMatchObject({ value: 3318.18 });
  });

  it('counts only tracking portfolios in the combined view and adds cash to the history', async () => {
    const s = setup();
    deposit(s);
    await settingsOn(s);
    const all = (await s.call('GET', '/portfolio')).body;
    expect(all.cashValue).toBe(3318.18);
    s.repo.eod = [{ symbol: 'VWRL.AS', date: '2026-06-15', close: 120, currency: 'EUR' }];
    const history = (await s.call('GET', '/history', { query: { portfolioId: 'default', range: '1M' } })).body.points;
    // EUR cash 4000 + VWRL 1200; AAPL has no close (valued at cost 750 USD) and cancels the -750 USD cash
    expect(history.at(-1).value).toBe(5200);
    expect(history[0].value).toBeGreaterThan(0);
  });
});

describe('categories', () => {
  it('creates, lists, updates and deletes categories', async () => {
    const s = setup();
    const created = await s.call('POST', '/portfolios/default/categories', { body: { name: ' Core ', color: '#ABCDEF', targetWeight: 60 } });
    expect(created).toMatchObject({ status: 201, body: { name: 'Core', color: '#abcdef', targetWeight: 60, portfolioId: 'default', userId: 'demo', categoryId: 'uuid-1' } });
    await addCategory(s, 'Crypto', 15.5);
    const list = (await s.call('GET', '/portfolios/default/categories')).body;
    expect(list).toMatchObject({ totalTarget: 75.5, unallocated: 24.5, assignments: [] });
    expect(list.categories.map((c: { name: string }) => c.name)).toEqual(['Core', 'Crypto']);
    expect((await s.call('GET', '/portfolios/broker/categories')).body.categories).toEqual([]);

    const updated = await s.call('PATCH', '/portfolios/default/categories/uuid-1', { body: { name: 'Core ETFs', targetWeight: 80 } });
    expect(updated).toMatchObject({ status: 200, body: { name: 'Core ETFs', targetWeight: 80 } });
    expect((await s.call('PATCH', '/portfolios/default/categories/uuid-1', { body: { color: '#000000' } })).body.targetWeight).toBe(80);
    expect((await s.call('DELETE', '/portfolios/default/categories/uuid-1')).status).toBe(204);
    expect((await s.call('GET', '/portfolios/default/categories')).body.categories).toHaveLength(1);
  });

  it('rejects invalid, duplicate and over-allocated categories', async () => {
    const s = setup();
    await addCategory(s, 'Core', 70);
    expect((await s.call('POST', '/portfolios/default/categories', { body: { name: '', color: '#000000', targetWeight: 10 } })).status).toBe(400);
    expect((await s.call('POST', '/portfolios/default/categories', { body: { name: 'x', color: 'blue', targetWeight: 10 } })).status).toBe(400);
    const dup = await s.call('POST', '/portfolios/default/categories', { body: { name: 'CORE', color: '#000000', targetWeight: 10 } });
    expect(dup.status).toBe(409);
    const over = await s.call('POST', '/portfolios/default/categories', { body: { name: 'More', color: '#000000', targetWeight: 40 } });
    expect(over).toMatchObject({ status: 422, body: { error: { details: { totalTarget: 110 } } } });
    const other = await addCategory(s, 'Other', 30);
    expect((await s.call('PATCH', `/portfolios/default/categories/${other.body.categoryId}`, { body: { targetWeight: 31 } })).status).toBe(422);
    expect((await s.call('PATCH', `/portfolios/default/categories/${other.body.categoryId}`, { body: { name: 'core' } })).status).toBe(409);
    expect((await s.call('PATCH', `/portfolios/default/categories/${other.body.categoryId}`, { body: {} })).status).toBe(400);
    expect((await s.call('PATCH', '/portfolios/default/categories/missing', { body: { name: 'x' } })).status).toBe(404);
    expect((await s.call('DELETE', '/portfolios/default/categories/missing')).status).toBe(404);
    expect((await s.call('POST', '/portfolios/nope/categories', { body: { name: 'x', color: '#000000', targetWeight: 1 } })).status).toBe(404);
  });

  it('limits the number of categories per portfolio', async () => {
    const s = setup();
    for (let i = 0; i < MAX_CATEGORIES; i++) await addCategory(s, `c${i}`, 0);
    expect((await addCategory(s, 'one too many', 0)).status).toBe(422);
  });

  it('assigns holdings: replaces the list and moves symbols between categories', async () => {
    const s = setup();
    const a = await addCategory(s, 'A', 50, ['VWRL.AS', 'aapl']);
    const b = await addCategory(s, 'B', 30);
    expect((await s.call('GET', '/portfolios/default/categories')).body.assignments.map((x: { symbol: string; categoryId: string }) => [x.symbol, x.categoryId])).toEqual([
      ['AAPL', a.body.categoryId],
      ['VWRL.AS', a.body.categoryId],
    ]);

    const moved = await s.call('PUT', `/portfolios/default/categories/${b.body.categoryId}/holdings`, { body: { symbols: ['AAPL', 'CASH.EUR', 'AAPL'] } });
    expect(moved.body.assignments.map((x: { symbol: string; categoryId: string }) => [x.symbol, x.categoryId])).toEqual([
      ['AAPL', b.body.categoryId],
      ['CASH.EUR', b.body.categoryId],
      ['VWRL.AS', a.body.categoryId],
    ]);
    const cleared = await s.call('PUT', `/portfolios/default/categories/${b.body.categoryId}/holdings`, { body: { symbols: [] } });
    expect(cleared.body.assignments.map((x: { symbol: string }) => x.symbol)).toEqual(['VWRL.AS']);

    // Deleting a category drops its assignments
    await s.call('DELETE', `/portfolios/default/categories/${a.body.categoryId}`);
    expect((await s.call('GET', '/portfolios/default/categories')).body.assignments).toEqual([]);
  });

  it('only assigns holdings of the portfolio, including custom assets', async () => {
    const s = setup();
    const c = await addCategory(s, 'A', 50);
    const path = `/portfolios/default/categories/${c.body.categoryId}/holdings`;
    const unknown = await s.call('PUT', path, { body: { symbols: ['MSFT', 'AAPL'] } }); // MSFT only exists in broker
    expect(unknown).toMatchObject({ status: 422, body: { error: { details: { unknownSymbols: ['MSFT'] } } } });
    expect((await s.call('PUT', path, { body: { symbols: ['bad symbol'] } })).status).toBe(400);
    expect((await s.call('PUT', '/portfolios/default/categories/missing/holdings', { body: { symbols: [] } })).status).toBe(404);

    const asset = await s.call('POST', '/portfolios/default/assets', { body: { name: 'House', currency: 'EUR', value: 1000 } });
    const custom = await s.call('PUT', path, { body: { symbols: [`custom:${asset.body.assetId.toUpperCase()}`] } });
    expect(custom.status).toBe(200);
  });

  it('allocates by category for a single portfolio only', async () => {
    const s = setup();
    const etfs = await addCategory(s, 'ETFs', 50, ['VWRL.AS']);
    const res = await s.call('GET', '/allocation', { query: { portfolioId: 'default', by: 'category' } });
    expect(res.body).toEqual({
      by: 'category',
      baseCurrency: 'EUR',
      slices: [
        { key: etfs.body.categoryId, label: 'ETFs', value: 1200, weight: 0.5455 },
        { key: 'unassigned', label: 'Uncategorized', value: 1000, weight: 0.4545 },
      ],
    });
    expect((await s.call('GET', '/allocation', { query: { by: 'category' } })).status).toBe(400);
    expect((await s.call('GET', '/allocation', { query: { portfolioId: 'all', by: 'category' } })).status).toBe(400);
    expect((await s.call('GET', '/allocation', { query: { by: 'bogus' } })).status).toBe(400);
  });
});

describe('GET /portfolios/{id}/rebalance', () => {
  it('suggests trades to reach the targets and reports drift before and after', async () => {
    const s = setup();
    await addCategory(s, 'ETFs', 50, ['VWRL.AS']);
    await addCategory(s, 'US stocks', 50, ['AAPL']);
    const res = await s.call('GET', '/portfolios/default/rebalance', { query: { mode: 'full' } });
    // VWRL 1200 vs AAPL 1000 (EUR): both targets are 1100
    expect(res.body).toMatchObject({ mode: 'full', totalBefore: 2200, basis: 2200, leftoverCash: 0, warnings: [] });
    expect(res.body.trades).toEqual([
      { symbol: 'VWRL.AS', name: 'VWRL.AS', categoryId: 'uuid-1', action: 'SELL', units: 0.833333, price: 120, value: 100 },
      { symbol: 'AAPL', name: 'AAPL', categoryId: 'uuid-2', action: 'BUY', units: 0.5, price: 200, value: 100 },
    ]);
    expect(res.body.rows[0]).toMatchObject({ name: 'ETFs', weightBefore: 54.55, driftBefore: 4.55, driftValueBefore: 100, weightAfter: 50, driftAfter: 0 });
  });

  it('invests new money buy-only with whole units and a minimum trade', async () => {
    const s = setup();
    await addCategory(s, 'ETFs', 50, ['VWRL.AS']);
    await addCategory(s, 'US stocks', 50, ['AAPL']);
    const res = await s.call('GET', '/portfolios/default/rebalance', { query: { mode: 'buy-only', amount: '1000', wholeUnits: 'true', minTrade: '50' } });
    // basis 3200 -> targets 1600 each: AAPL (200/unit) is 600 short, VWRL (120/unit) 400 short
    expect(res.body.trades.map((t: { symbol: string; units: number }) => [t.symbol, t.units])).toEqual([
      ['AAPL', 3],
      ['VWRL.AS', 3],
    ]);
    expect(res.body.leftoverCash).toBe(40);
  });

  it('validates query and portfolio, and works without categories', async () => {
    const s = setup();
    expect((await s.call('GET', '/portfolios/default/rebalance', { query: { mode: 'sell' } })).status).toBe(400);
    expect((await s.call('GET', '/portfolios/default/rebalance', { query: { amount: '-5' } })).status).toBe(400);
    expect((await s.call('GET', '/portfolios/nope/rebalance')).status).toBe(404);
    const empty = await s.call('GET', '/portfolios/default/rebalance');
    expect(empty.body).toMatchObject({ trades: [], rows: [], unallocated: { valueBefore: 2200 } });
  });
});

describe('custom assets', () => {
  const create = (s: Setup, body: object = {}, portfolioId = 'default') =>
    s.call('POST', `/portfolios/${portfolioId}/assets`, { body: { name: 'Apartment', assetClass: 'REAL_ESTATE', currency: 'EUR', value: 200000, date: '2025-06-15', costBasis: 180000, growthRate: 5, ...body } });

  it('creates an asset with a first valuation and today value including growth', async () => {
    const s = setup();
    const res = await create(s);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      assetId: 'uuid-1',
      name: 'Apartment',
      assetClass: 'REAL_ESTATE',
      costBasis: 180000,
      growthRate: 5,
      valuations: [{ date: '2025-06-15', value: 200000 }],
      currentValueLocal: 210000, // one year after the valuation
      currentValue: 210000,
    });
  });

  it('defaults cost to the initial value, the class to OTHER and the date to today; converts foreign currencies', async () => {
    const s = setup();
    const res = await s.call('POST', '/portfolios/default/assets', { body: { name: 'P2P', currency: 'usd', value: 1100 } });
    expect(res.body).toMatchObject({ assetClass: 'OTHER', costBasis: 1100, currency: 'USD', valuations: [{ date: '2026-06-15', value: 1100 }], currentValueLocal: 1100, currentValue: 1000 });
    expect(res.body.growthRate).toBeUndefined();
    const list = (await s.call('GET', '/portfolios/default/assets')).body;
    expect(list.baseCurrency).toBe('EUR');
    expect(list.assets).toHaveLength(1);
  });

  it('lists only the assets of the portfolio and user', async () => {
    const s = setup();
    await create(s);
    await create(s, { name: 'Broker asset' }, 'broker');
    expect((await s.call('GET', '/portfolios/default/assets')).body.assets.map((a: { name: string }) => a.name)).toEqual(['Apartment']);
    expect((await s.call('GET', '/portfolios/default/assets', { sub: 'someone-else' })).body.assets).toEqual([]);
    expect((await s.call('GET', '/portfolios/nope/assets')).status).toBe(404);
  });

  it('validates input and the maximum', async () => {
    const s = setup();
    expect((await create(s, { value: -1 })).status).toBe(400);
    expect((await create(s, { currency: 'EURO' })).status).toBe(400);
    expect((await create(s, { assetClass: 'STOCKS' })).status).toBe(400);
    for (let i = 0; i < MAX_CUSTOM_ASSETS; i++) await create(s, { name: `a${i}` });
    expect((await create(s, { name: 'extra' })).status).toBe(422);
  });

  it('updates fields and removes the growth rate with null', async () => {
    const s = setup();
    const { body } = await create(s);
    const path = `/portfolios/default/assets/${body.assetId}`;
    const renamed = await s.call('PATCH', path, { body: { name: 'Flat', costBasis: 150000 } });
    expect(renamed.body).toMatchObject({ name: 'Flat', costBasis: 150000, growthRate: 5 });
    expect((await s.call('PATCH', path, { body: { growthRate: 3 } })).body.growthRate).toBe(3);
    const noGrowth = await s.call('PATCH', path, { body: { growthRate: null } });
    expect(noGrowth.body.growthRate).toBeUndefined();
    expect(noGrowth.body.currentValueLocal).toBe(200000);
    expect((await s.call('PATCH', path, { body: {} })).status).toBe(400);
    expect((await s.call('PATCH', '/portfolios/default/assets/missing', { body: { name: 'x' } })).status).toBe(404);
  });

  it('upserts and deletes valuation points but keeps at least one', async () => {
    const s = setup();
    const { body } = await create(s, { growthRate: null });
    const path = `/portfolios/default/assets/${body.assetId}`;
    const added = await s.call('PUT', `${path}/valuations`, { body: { date: '2026-01-01', value: 220000 } });
    expect(added.body).toMatchObject({ valuations: [{ date: '2025-06-15' }, { date: '2026-01-01', value: 220000 }], currentValueLocal: 220000 });
    const replaced = await s.call('PUT', `${path}/valuations`, { body: { date: '2026-01-01', value: 230000 } });
    expect(replaced.body.valuations).toHaveLength(2);
    expect((await s.call('PUT', `${path}/valuations`, { body: { date: 'x', value: 1 } })).status).toBe(400);
    expect((await s.call('PUT', '/portfolios/default/assets/missing/valuations', { body: { date: '2026-01-01', value: 1 } })).status).toBe(404);

    expect((await s.call('DELETE', `${path}/valuations/2024-01-01`)).status).toBe(404);
    expect((await s.call('DELETE', `${path}/valuations/nope`)).status).toBe(400);
    const removed = await s.call('DELETE', `${path}/valuations/2026-01-01`);
    expect(removed.body.valuations).toHaveLength(1);
    expect((await s.call('DELETE', `${path}/valuations/2025-06-15`)).status).toBe(422);
  });

  it('limits the number of valuation points', async () => {
    const s = setup();
    const { body } = await create(s);
    const asset = s.mgmt.assets[0]!;
    asset.valuations = Array.from({ length: MAX_VALUATIONS }, (_, i) => ({ date: new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10), value: 1 }));
    const res = await s.call('PUT', `/portfolios/default/assets/${body.assetId}/valuations`, { body: { date: '2030-01-01', value: 1 } });
    expect(res.status).toBe(422);
  });

  it('deletes an asset', async () => {
    const s = setup();
    const { body } = await create(s);
    expect((await s.call('DELETE', `/portfolios/default/assets/${body.assetId}`)).status).toBe(204);
    expect((await s.call('DELETE', `/portfolios/default/assets/${body.assetId}`)).status).toBe(404);
  });

  it('reports 503 when the asset currency has no FX rate', async () => {
    const s = setup();
    await create(s, { currency: 'JPY' });
    expect((await s.call('GET', '/portfolios/default/assets')).status).toBe(503);
  });

  it('values base-currency assets even without stored FX rates', async () => {
    const s = setup();
    s.repo.fx = null;
    expect((await create(s)).body.currentValue).toBe(210000);
  });

  it('counts custom assets in holdings, totals and allocation without touching the price feed', async () => {
    const s = setup();
    await create(s);
    const summary = (await s.call('GET', '/portfolio', { query: { portfolioId: 'default' } })).body;
    expect(summary).toMatchObject({ customAssetsValue: 210000, totalValue: 212200, holdingsCount: 3 });
    const holdings = (await s.call('GET', '/holdings', { query: { portfolioId: 'default' } })).body.holdings;
    expect(holdings[0]).toMatchObject({ symbol: 'CUSTOM:uuid-1', assetClass: 'REAL_ESTATE', marketValue: 210000, costBasis: 180000, unrealizedPnl: 30000 });
    const allocation = (await s.call('GET', '/allocation', { query: { by: 'assetClass' } })).body.slices;
    expect(allocation[0]).toMatchObject({ key: 'REAL_ESTATE', value: 210000 });
    expect(s.repo.tracked.size).toBe(0);
    expect((await s.call('GET', '/portfolio', { query: { portfolioId: 'broker' } })).body.customAssetsValue).toBeUndefined();
  });
});

describe('watchlist', () => {
  it('adds a symbol, registers it as tracked and asks for enrichment', async () => {
    const s = setup();
    const res = await s.call('POST', '/watchlist', { body: { symbol: ' nvda ' } });
    expect(res).toMatchObject({ status: 201, body: { symbol: 'NVDA', addedAt: NOW } });
    expect(res.body.price).toBeUndefined();
    expect(s.repo.tracked.has('NVDA')).toBe(true);
    expect(s.repo.users.has('demo')).toBe(true);
    expect(s.events.published).toEqual([{ userId: 'demo', portfolioId: 'watchlist', symbols: ['NVDA'], reason: 'CREATED' }]);
  });

  it('lists symbols with latest price, day change and name', async () => {
    const s = setup();
    s.repo.quotes.NVDA = { symbol: 'NVDA', price: 110, previousClose: 100, currency: 'USD', asOf: NOW, source: 'test' };
    s.repo.quotes.ZERO = { symbol: 'ZERO', price: 1, previousClose: 0, currency: 'USD', asOf: NOW, source: 'test' };
    s.repo.profiles.NVDA = { symbol: 'NVDA', name: 'NVIDIA', assetClass: 'STOCK', currency: 'USD' };
    s.repo.profiles.PEND = { symbol: 'PEND', name: 'Pending Inc', assetClass: 'STOCK', currency: 'EUR' };
    for (const symbol of ['NVDA', 'ZERO', 'PEND']) await s.call('POST', '/watchlist', { body: { symbol } });
    const { items } = (await s.call('GET', '/watchlist')).body;
    expect(items).toEqual([
      { symbol: 'NVDA', name: 'NVIDIA', currency: 'USD', price: 110, previousClose: 100, change: 10, changePct: 10, asOf: NOW, addedAt: NOW },
      { symbol: 'PEND', name: 'Pending Inc', currency: 'EUR', addedAt: NOW },
      { symbol: 'ZERO', currency: 'USD', price: 1, previousClose: 0, change: 1, changePct: 0, asOf: NOW, addedAt: NOW },
    ]);
    expect((await s.call('GET', '/watchlist', { sub: 'someone-else' })).body.items).toEqual([]);
  });

  it('is empty by default', async () => {
    const s = setup();
    expect((await s.call('GET', '/watchlist')).body).toEqual({ items: [] });
  });

  it('rejects duplicates, invalid symbols and too many entries', async () => {
    const s = setup();
    await s.call('POST', '/watchlist', { body: { symbol: 'NVDA' } });
    expect((await s.call('POST', '/watchlist', { body: { symbol: 'nvda' } })).status).toBe(409);
    expect((await s.call('POST', '/watchlist', { body: { symbol: 'not valid' } })).status).toBe(400);
    expect((await s.call('POST', '/watchlist', { body: {} })).status).toBe(400);
    for (let i = 0; i < MAX_WATCHLIST - 1; i++) await s.call('POST', '/watchlist', { body: { symbol: `S${i}` } });
    expect((await s.call('POST', '/watchlist', { body: { symbol: 'LAST' } })).status).toBe(422);
  });

  it('removes symbols case-insensitively and reports unknown ones', async () => {
    const s = setup();
    await s.call('POST', '/watchlist', { body: { symbol: '^GSPC' } });
    expect((await s.call('DELETE', '/watchlist/%5Egspc')).status).toBe(204);
    expect((await s.call('DELETE', '/watchlist/NVDA')).status).toBe(404);
    expect(s.repo.tracked.has('^GSPC')).toBe(true); // other users may still rely on the price feed
  });
});

describe('exports', () => {
  it('exports transactions as CSV, optionally for one portfolio', async () => {
    const s = setup();
    s.repo.transactions.push(txn({ id: 'n', date: '2025-07-01', type: 'DIVIDEND', symbol: 'AAPL', quantity: 5, price: 0.25, currency: 'USD', note: 'Q2, net', fxRate: 1.08 }));
    const all = await s.call('GET', '/export/transactions');
    expect(all.res.headers).toMatchObject({
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="transactions-all-2026-06-15.csv"',
    });
    expect(all.res.body).toBe(
      [
        'date,type,symbol,quantity,price,fee,currency,note,fxRate',
        '2025-01-10,BUY,VWRL.AS,10,100,0,EUR,,',
        '2025-03-03,BUY,AAPL,5,150,0,USD,,',
        '2025-05-02,BUY,MSFT,2,400,0,USD,,',
        '2025-07-01,DIVIDEND,AAPL,5,0.25,0,USD,"Q2, net",1.08',
        '',
      ].join('\n'),
    );
    const broker = await s.call('GET', '/export/transactions', { query: { portfolioId: 'broker' } });
    expect(broker.res.body).toBe('date,type,symbol,quantity,price,fee,currency,note,fxRate\n2025-05-02,BUY,MSFT,2,400,0,USD,,\n');
    expect(broker.res.headers!['content-disposition']).toContain('transactions-broker-');
    expect((await s.call('GET', '/export/transactions', { query: { portfolioId: 'nope' } })).status).toBe(404);
  });

  it('exports a complete JSON backup of the user only', async () => {
    const s = setup();
    await settingsOn(s);
    await addCategory(s, 'Core', 50, ['AAPL']);
    await s.call('POST', '/portfolios/default/assets', { body: { name: 'House', currency: 'EUR', value: 1 } });
    await s.call('POST', '/watchlist', { body: { symbol: 'NVDA' } });
    await settingsOn(s, 'broker');
    s.mgmt.watchlist.push({ userId: 'someone-else', symbol: 'TSLA', addedAt: 'x' });
    const { status, body } = await s.call('GET', '/export/backup');
    expect(status).toBe(200);
    expect(body).toMatchObject({ version: 1, exportedAt: NOW, baseCurrency: 'EUR' });
    expect(body.portfolios.map((p: { portfolioId: string }) => p.portfolioId)).toEqual(['default', 'broker']);
    expect(body.transactions).toHaveLength(3);
    expect(body.settings).toHaveLength(2);
    expect(body.categories).toHaveLength(1);
    expect(body.categoryAssignments).toHaveLength(1);
    expect(body.customAssets).toHaveLength(1);
    expect(body.watchlist.map((w: { symbol: string }) => w.symbol)).toEqual(['NVDA']);
    expect(JSON.stringify(body)).not.toMatch(/secret|password|token/i);
  });
});

describe('deleting a portfolio', () => {
  it('removes its settings, categories, assignments and custom assets', async () => {
    const s = setup();
    await settingsOn(s, 'broker');
    await addCategory(s, 'Core', 50, ['MSFT'], 'broker');
    await s.call('POST', '/portfolios/broker/assets', { body: { name: 'House', currency: 'EUR', value: 1 } });
    await settingsOn(s);
    const res = await s.call('DELETE', '/portfolios/broker', { query: { force: 'true' } });
    expect(res.status).toBe(204);
    expect([s.mgmt.settings, s.mgmt.categories, s.mgmt.assignments, s.mgmt.assets].map((x) => x.map((i) => i.portfolioId))).toEqual([['default'], [], [], []]);
  });
});
