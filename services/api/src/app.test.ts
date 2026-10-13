import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { createHandler } from './app.js';
import { apiEvent, fakeDeps, txn } from './testing/fakes.js';
import type { Deps } from './deps.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);

function setup(overrides: Partial<Deps> = {}) {
  const ctx = fakeDeps(overrides);
  const { repo } = ctx;
  repo.transactions = [
    txn({ id: 't1', date: '2025-01-10', type: 'BUY', symbol: 'VWRL.AS', quantity: 10, price: 100, fee: 2 }),
    txn({ id: 't2', date: '2025-03-03', type: 'BUY', symbol: 'AAPL', quantity: 5, price: 150, currency: 'USD' }),
    txn({ id: 't3', date: '2025-08-01', type: 'DIVIDEND', symbol: 'AAPL', quantity: 5, price: 0.25, currency: 'USD' }),
    txn({ id: 'other', userId: 'someone-else', date: '2025-01-01', type: 'BUY', symbol: 'MSFT', quantity: 1, price: 1, currency: 'USD' }),
  ];
  repo.quotes = {
    'VWRL.AS': { symbol: 'VWRL.AS', price: 120, previousClose: 118, currency: 'EUR', asOf: '2026-06-15T17:00:00Z', source: 'test' },
    AAPL: { symbol: 'AAPL', price: 220, previousClose: 215, currency: 'USD', asOf: '2026-06-15T20:00:00Z', source: 'test' },
  };
  repo.profiles = {
    'VWRL.AS': { symbol: 'VWRL.AS', name: 'Vanguard All-World', assetClass: 'ETF', sector: 'Diversified', country: 'Global', currency: 'EUR' },
    AAPL: { symbol: 'AAPL', name: 'Apple', assetClass: 'STOCK', sector: 'Technology', country: 'US', currency: 'USD' },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.1 }, asOf: '2026-06-15T00:00:00Z' };
  return { ...ctx, handler: createHandler(() => ctx.deps) };
}

describe('routing & errors', () => {
  it('returns 404 with error envelope for unknown routes', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/nope'));
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });

  it('returns 404 for a known path with the wrong method', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('PUT', '/transactions'))).statusCode).toBe(404);
  });

  it('serves /health, tolerates /api prefix and trailing slash, and sets CORS headers', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/api/health/'));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ status: 'ok' });
    expect(res.headers?.['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('answers OPTIONS preflight with 204', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('OPTIONS', '/transactions'))).statusCode).toBe(204);
  });

  it('returns 400 VALIDATION_ERROR with zod issues for bad query params', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/allocation', { query: { by: 'colour' } }));
    expect(res.statusCode).toBe(400);
    const body = json(res);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details[0].path).toEqual(['by']);
  });

  it('returns 400 for invalid JSON and invalid transaction bodies', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('POST', '/transactions', { body: '{oops' }))).statusCode).toBe(400);
    const res = await handler(apiEvent('POST', '/transactions', { body: { date: '2026-13', type: 'HOLD', symbol: '', quantity: -1 } }));
    expect(res.statusCode).toBe(400);
    expect(json(res).error.details.length).toBeGreaterThan(1);
  });

  it('maps MissingFxRateError to 503 FX_UNAVAILABLE', async () => {
    const { handler, repo } = setup();
    repo.fx = null;
    const res = await handler(apiEvent('GET', '/portfolio'));
    expect(res.statusCode).toBe(503);
    expect(json(res).error.code).toBe('FX_UNAVAILABLE');
  });

  it('works without an FX item when every transaction is in the base currency', async () => {
    const { handler, repo } = setup();
    repo.fx = null;
    repo.transactions = repo.transactions.filter((t) => t.currency === 'EUR');
    const res = await handler(apiEvent('GET', '/portfolio'));
    expect(res.statusCode).toBe(200);
    expect(json(res).totalValue).toBe(1200);
  });

  it('returns 500 without leaking the stack on unexpected errors', async () => {
    const { handler, repo } = setup();
    repo.listTransactions = async () => {
      throw new Error('boom secret detail');
    };
    const res = await handler(apiEvent('GET', '/portfolio'));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('boom');
    expect(json(res)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  it('uses the JWT sub claim as userId when present', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/transactions', { sub: 'someone-else' }));
    expect(json(res).transactions.map((t: { id: string }) => t.id)).toEqual(['other']);
  });
});

describe('read routes', () => {
  it('GET /portfolio returns the summary in base currency', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/portfolio')));
    // VWRL 10*120 = 1200 EUR; AAPL 5*220/1.1 = 1000 EUR
    expect(body).toMatchObject({ baseCurrency: 'EUR', totalValue: 2200, holdingsCount: 2 });
    expect(body.dividendsReceived).toBeCloseTo(1.14, 2);
  });

  it('GET /holdings returns holdings sorted by value', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/holdings')));
    expect(body.baseCurrency).toBe('EUR');
    expect(body.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(['VWRL.AS', 'AAPL']);
  });

  it('GET /allocation defaults to assetClass and honours ?by=', async () => {
    const { handler } = setup();
    const byClass = json(await handler(apiEvent('GET', '/allocation')));
    expect(byClass.by).toBe('assetClass');
    expect(byClass.slices.map((s: { key: string }) => s.key)).toEqual(['ETF', 'STOCK']);
    const byCountry = json(await handler(apiEvent('GET', '/allocation', { query: { by: 'country' } })));
    expect(byCountry.slices).toHaveLength(2);
    expect(byCountry.slices[0]).toMatchObject({ key: 'Global', weight: 0.5455 });
  });

  it('GET /history returns ≤ 400 points with first/last kept', async () => {
    const { handler, repo } = setup();
    repo.eod = [
      { symbol: 'VWRL.AS', date: '2026-05-10', close: 110, currency: 'EUR' },
      { symbol: 'AAPL', date: '2026-05-10', close: 200, currency: 'USD' },
    ];
    const all = json(await handler(apiEvent('GET', '/history', { query: { range: 'ALL' } })));
    expect(all.range).toBe('ALL');
    expect(all.points.length).toBe(400);
    expect(all.points[0].date).toBe('2025-01-10');
    expect(all.points.at(-1).date).toBe('2026-06-15');

    const month = json(await handler(apiEvent('GET', '/history', { query: { range: '1M' } })));
    expect(month.points).toHaveLength(31);
    expect(month.points.at(-1)).toMatchObject({ date: '2026-06-15' });
    // carry-forward close seeded from before the range: 10*110 + 5*200/1.1
    expect(month.points[0].value).toBeCloseTo(2009.09, 2);
  });

  it('GET /history returns empty points for a user without transactions', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/history', { sub: 'nobody' })));
    expect(body).toEqual({ range: '1Y', baseCurrency: 'EUR', points: [] });
  });

  it('GET /dividends combines received and upcoming events for held symbols', async () => {
    const { handler, repo } = setup();
    repo.dividendEvents = [
      { symbol: 'AAPL', exDate: '2026-07-01', payDate: '2026-07-10', amount: 0.3, currency: 'USD' },
      { symbol: 'MSFT', exDate: '2026-07-01', amount: 1, currency: 'USD' },
    ];
    const body = json(await handler(apiEvent('GET', '/dividends')));
    expect(body.received).toHaveLength(1);
    expect(body.upcoming).toEqual([expect.objectContaining({ symbol: 'AAPL', date: '2026-07-10', status: 'UPCOMING' })]);
  });

  it('GET /transactions lists the user transactions newest first', async () => {
    const { handler } = setup();
    const body = json(await handler(apiEvent('GET', '/transactions')));
    expect(body.transactions.map((t: { id: string }) => t.id)).toEqual(['t3', 't2', 't1']);
  });
});

describe('POST /transactions', () => {
  it('rejects an oversell with 422 and writes nothing', async () => {
    const { handler, repo, events } = setup();
    const before = repo.transactions.length;
    const res = await handler(
      apiEvent('POST', '/transactions', { body: { date: '2026-06-01', type: 'SELL', symbol: 'aapl', quantity: 6, price: 210, currency: 'usd' } }),
    );
    expect(res.statusCode).toBe(422);
    expect(json(res).error.code).toBe('UNPROCESSABLE');
    expect(repo.transactions).toHaveLength(before);
    expect(events.published).toHaveLength(0);
  });

  it('creates the transaction, registers user + ticker and publishes TransactionsChanged', async () => {
    const { handler, repo, events } = setup();
    const res = await handler(
      apiEvent('POST', '/transactions', { body: { date: '2026-06-01', type: 'BUY', symbol: 'msft', quantity: '2', price: 400, currency: 'usd' } }),
    );
    expect(res.statusCode).toBe(201);
    const created = json(res);
    expect(created).toMatchObject({ id: 'uuid-1', userId: 'demo', symbol: 'MSFT', quantity: 2, fee: 0, currency: 'USD', createdAt: '2026-06-15T12:00:00.000Z' });
    expect(created).not.toHaveProperty('note');
    expect(repo.transactions.find((t) => t.id === 'uuid-1')).toBeDefined();
    expect(repo.users.has('demo')).toBe(true);
    expect(repo.tracked.get('MSFT')).toBe('USD');
    expect(events.published).toEqual([{ userId: 'demo', symbols: ['MSFT'], reason: 'CREATED' }]);
  });

  it('still succeeds when publishing the event fails', async () => {
    const { handler, deps } = setup();
    deps.events.transactionsChanged = async () => {
      throw new Error('eventbridge down');
    };
    const res = await handler(
      apiEvent('POST', '/transactions', { body: { date: '2026-06-01', type: 'BUY', symbol: 'MSFT', quantity: 1, price: 400, currency: 'USD' } }),
    );
    expect(res.statusCode).toBe(201);
  });
});

describe('DELETE /transactions/{id}', () => {
  it('returns 404 when the transaction does not exist (or belongs to another user)', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('DELETE', '/transactions/missing'))).statusCode).toBe(404);
    expect((await handler(apiEvent('DELETE', '/transactions/other'))).statusCode).toBe(404);
  });

  it('rejects deleting a BUY that a later SELL depends on with 422', async () => {
    const { handler, repo } = setup();
    repo.transactions.push(txn({ id: 't4', date: '2025-09-01', type: 'SELL', symbol: 'VWRL.AS', quantity: 8, price: 110 }));
    const res = await handler(apiEvent('DELETE', '/transactions/t1'));
    expect(res.statusCode).toBe(422);
    expect(repo.transactions.some((t) => t.id === 't1')).toBe(true);
  });

  it('deletes and publishes DELETED', async () => {
    const { handler, repo, events } = setup();
    const res = await handler(apiEvent('DELETE', '/transactions/t1'));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(repo.transactions.some((t) => t.id === 't1')).toBe(false);
    expect(events.published).toEqual([{ userId: 'demo', symbols: ['VWRL.AS'], reason: 'DELETED' }]);
  });
});

describe('imports', () => {
  it('POST /imports writes a PENDING import and returns a presigned URL', async () => {
    const { handler, repo } = setup();
    const res = await handler(apiEvent('POST', '/imports', { body: { fileName: 'trades.csv' } }));
    expect(res.statusCode).toBe(201);
    expect(json(res)).toEqual({
      importId: 'uuid-1',
      uploadUrl: 'https://bucket.example/imports/demo/uuid-1.csv?X-Amz-Expires=300',
      expiresInSeconds: 300,
    });
    expect(repo.imports.get('demo/uuid-1')).toMatchObject({ status: 'PENDING', fileName: 'trades.csv', userId: 'demo' });
  });

  it('POST /imports rejects non-csv file names', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('POST', '/imports', { body: { fileName: 'trades.xlsx' } }))).statusCode).toBe(400);
  });

  it('GET /imports/{id} returns the status or 404', async () => {
    const { handler } = setup();
    const created = json(await handler(apiEvent('POST', '/imports', { body: { fileName: 'a.csv' } })));
    const res = await handler(apiEvent('GET', `/imports/${created.importId}`));
    expect(res.statusCode).toBe(200);
    expect(json(res).status).toBe('PENDING');
    expect((await handler(apiEvent('GET', '/imports/unknown'))).statusCode).toBe(404);
  });
});
