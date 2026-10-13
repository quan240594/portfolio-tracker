import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { MissingFxRateError, PortfolioError } from '@portfolio/shared';
import { createHandler, errorToResult, resolveUserId } from './app.js';
import { HttpError } from './lib/http.js';
import { logger } from './lib/logger.js';
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveUserId', () => {
  const withClaims = (claims: Record<string, unknown> | undefined) => {
    const event = apiEvent('GET', '/portfolio');
    (event.requestContext as unknown as { authorizer: unknown }).authorizer = { jwt: { claims } };
    return event;
  };

  it('prefers a non-empty string sub claim', () => {
    expect(resolveUserId(withClaims({ sub: 'user-123' }), 'demo')).toBe('user-123');
  });

  it('falls back to the demo user without an authorizer, claims, or a usable sub', () => {
    expect(resolveUserId(apiEvent('GET', '/portfolio'), 'demo')).toBe('demo');
    expect(resolveUserId(withClaims(undefined), 'demo')).toBe('demo');
    expect(resolveUserId(withClaims({ sub: '' }), 'demo')).toBe('demo');
    expect(resolveUserId(withClaims({ sub: 42 }), 'demo')).toBe('demo');
  });
});

describe('errorToResult', () => {
  it('maps HttpError including details', () => {
    expect(errorToResult(new HttpError(409, 'CONFLICT', 'dup', { id: 'x' }))).toEqual({
      statusCode: 409,
      body: { error: { code: 'CONFLICT', message: 'dup', details: { id: 'x' } } },
    });
  });

  it('maps domain errors to 503 / 422', () => {
    expect(errorToResult(new MissingFxRateError('USD', 'EUR'))).toEqual({
      statusCode: 503,
      body: { error: { code: 'FX_UNAVAILABLE', message: 'No FX rate for USD against base EUR' } },
    });
    expect(errorToResult(new PortfolioError('oversold'))).toEqual({
      statusCode: 422,
      body: { error: { code: 'UNPROCESSABLE', message: 'oversold' } },
    });
  });

  it('maps anything else (including non-Error values) to an opaque 500', () => {
    const opaque = { statusCode: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } };
    expect(errorToResult(new TypeError('x is undefined'))).toEqual(opaque);
    expect(errorToResult('a string')).toEqual(opaque);
    expect(errorToResult(undefined)).toEqual(opaque);
  });
});

describe('handler logging & request handling', () => {
  it('tags logs with the Lambda request id, falling back to the API Gateway request id', async () => {
    const { handler } = setup();
    const append = vi.spyOn(logger, 'appendKeys');
    const remove = vi.spyOn(logger, 'removeKeys');
    await handler(apiEvent('GET', '/health'), { awsRequestId: 'lambda-1' });
    await handler(apiEvent('GET', '/health'));
    expect(append.mock.calls).toEqual([[{ requestId: 'lambda-1' }], [{ requestId: 'req-1' }]]);
    expect(remove).toHaveBeenCalledWith(['requestId']);
  });

  it('logs completed requests with the matched route template', async () => {
    const { handler } = setup();
    const info = vi.spyOn(logger, 'info');
    await handler(apiEvent('DELETE', '/transactions/t1'));
    expect(info).toHaveBeenCalledWith(
      'Request completed',
      expect.objectContaining({ route: 'DELETE /transactions/{id}', method: 'DELETE', statusCode: 204, latencyMs: expect.any(Number) }),
    );
  });

  it('logs 4xx as warnings with the raw path for unmatched routes', async () => {
    const { handler } = setup();
    const warn = vi.spyOn(logger, 'warn');
    const error = vi.spyOn(logger, 'error');
    await handler(apiEvent('GET', '/nope'));
    expect(warn).toHaveBeenCalledWith('Request rejected', {
      route: 'GET /nope',
      statusCode: 404,
      reason: 'Route not found: GET /nope',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('logs 5xx as errors including the original error', async () => {
    const { handler, repo } = setup();
    const boom = new Error('boom');
    repo.listTransactions = async () => {
      throw boom;
    };
    const error = vi.spyOn(logger, 'error');
    const res = await handler(apiEvent('GET', '/holdings'));
    expect(res.statusCode).toBe(500);
    expect(error).toHaveBeenCalledWith('Request failed', { route: 'GET /holdings', error: boom });
  });

  it('accepts lower-case HTTP methods', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('get', '/health'))).statusCode).toBe(200);
  });

  it('sets full CORS and no-store headers on success, error and preflight responses', async () => {
    const { handler } = setup();
    const expected = {
      'content-type': 'application/json',
      'access-control-allow-origin': 'http://localhost:5173',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      'cache-control': 'no-store',
    };
    for (const event of [apiEvent('GET', '/health'), apiEvent('GET', '/nope'), apiEvent('OPTIONS', '/anything')]) {
      expect((await handler(event)).headers).toEqual(expected);
    }
    const preflight = await handler(apiEvent('OPTIONS', '/anything'));
    expect(preflight.body).toBe('');
  });

  it('answers OPTIONS without touching dependencies beyond config', async () => {
    const { handler, repo } = setup();
    const list = vi.spyOn(repo, 'listTransactions');
    await handler(apiEvent('OPTIONS', '/transactions'));
    expect(list).not.toHaveBeenCalled();
  });
});

describe('empty portfolio', () => {
  it('GET /portfolio returns zero totals without loading quotes or profiles', async () => {
    const { handler, repo } = setup();
    const quotes = vi.spyOn(repo, 'getQuotes');
    const profiles = vi.spyOn(repo, 'getProfiles');
    const res = await handler(apiEvent('GET', '/portfolio', { sub: 'nobody' }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ baseCurrency: 'EUR', totalValue: 0, holdingsCount: 0 });
    expect(quotes).not.toHaveBeenCalled();
    expect(profiles).not.toHaveBeenCalled();
  });

  it('GET /holdings, /allocation and /dividends return empty collections', async () => {
    const { handler } = setup();
    expect(json(await handler(apiEvent('GET', '/holdings', { sub: 'nobody' })))).toEqual({ baseCurrency: 'EUR', holdings: [] });
    expect(json(await handler(apiEvent('GET', '/allocation', { sub: 'nobody' })))).toMatchObject({ by: 'assetClass', slices: [] });
    expect(json(await handler(apiEvent('GET', '/dividends', { sub: 'nobody' })))).toMatchObject({ received: [], upcoming: [] });
    expect(json(await handler(apiEvent('GET', '/transactions', { sub: 'nobody' })))).toEqual({ transactions: [] });
  });

  it('a fully sold position is not treated as held', async () => {
    const { handler, repo } = setup();
    repo.transactions.push(txn({ id: 't9', date: '2025-09-01', type: 'SELL', symbol: 'VWRL.AS', quantity: 10, price: 130 }));
    const getQuotes = vi.spyOn(repo, 'getQuotes');
    const body = json(await handler(apiEvent('GET', '/holdings')));
    expect(body.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(['AAPL']);
    expect(getQuotes).toHaveBeenCalledWith(['AAPL']);
  });
});

describe('query parameter handling', () => {
  it('GET /history rejects an unknown range and defaults to 1Y', async () => {
    const { handler } = setup();
    const bad = await handler(apiEvent('GET', '/history', { query: { range: '2W' } }));
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' });
    const def = json(await handler(apiEvent('GET', '/history')));
    expect(def.range).toBe('1Y');
    expect(def.points[0].date).toBe('2025-06-15');
    expect(def.points.at(-1).date).toBe('2026-06-15');
  });

  it('GET /history loads EOD for every symbol ever traded, with a lookback before the range', async () => {
    const { handler, repo } = setup();
    repo.transactions.push(txn({ id: 't9', date: '2025-09-01', type: 'SELL', symbol: 'VWRL.AS', quantity: 10, price: 130 }));
    const getEod = vi.spyOn(repo, 'getEod');
    await handler(apiEvent('GET', '/history', { query: { range: '1M' } }));
    expect(getEod.mock.calls.map((c) => c[0]).sort()).toEqual(['AAPL', 'VWRL.AS']);
    expect(getEod).toHaveBeenCalledWith('AAPL', '2026-05-02', '2026-06-15'); // range starts 2026-05-16, minus 14 days lookback;
  });

  it('GET /history returns 503 when a foreign-currency rate is missing', async () => {
    const { handler, repo } = setup();
    repo.fx = null;
    const res = await handler(apiEvent('GET', '/history', { query: { range: '1M' } }));
    expect(res.statusCode).toBe(503);
    expect(json(res).error.message).toContain('USD');
  });

  it('GET /allocation validation error carries a specific message', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('GET', '/allocation', { query: { by: 'colour' } }));
    expect(json(res).error.message).toBe('Invalid query parameters');
  });
});

describe('transactions edge cases', () => {
  it('orders same-day transactions by createdAt, newest first', async () => {
    const { handler, repo } = setup();
    repo.transactions.push(
      txn({ id: 'early', date: '2025-08-01', type: 'BUY', symbol: 'VWRL.AS', quantity: 1, price: 1, createdAt: '2025-08-01T08:00:00.000Z' }),
      txn({ id: 'late', date: '2025-08-01', type: 'BUY', symbol: 'VWRL.AS', quantity: 1, price: 1, createdAt: '2025-08-01T18:00:00.000Z' }),
    );
    const ids = json(await handler(apiEvent('GET', '/transactions'))).transactions.map((t: { id: string }) => t.id);
    expect(ids).toEqual(['late', 't3', 'early', 't2', 't1']);
  });

  it('keeps a provided note and accepts base64-encoded bodies', async () => {
    const { handler, repo } = setup();
    const event = apiEvent('POST', '/transactions');
    event.body = Buffer.from(
      JSON.stringify({ date: '2026-06-01', type: 'BUY', symbol: 'MSFT', quantity: 1, price: 400, fee: 1.5, currency: 'USD', note: 'first' }),
    ).toString('base64');
    event.isBase64Encoded = true;
    const res = await handler(event);
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({ note: 'first', fee: 1.5 });
    expect(repo.transactions.at(-1)).toMatchObject({ id: 'uuid-1', note: 'first' });
  });

  it('rejects a missing body with 400', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('POST', '/transactions'));
    expect(res.statusCode).toBe(400);
    expect(json(res).error.message).toBe('Request body is required');
  });

  it('does not register user/ticker or publish when the write fails', async () => {
    const { handler, repo, events } = setup();
    repo.putTransaction = async () => {
      throw new Error('ddb down');
    };
    const res = await handler(
      apiEvent('POST', '/transactions', { body: { date: '2026-06-01', type: 'BUY', symbol: 'MSFT', quantity: 1, price: 400, currency: 'USD' } }),
    );
    expect(res.statusCode).toBe(500);
    expect(repo.users.size).toBe(0);
    expect(repo.tracked.size).toBe(0);
    expect(events.published).toHaveLength(0);
  });

  it('logs and swallows publish failures on create and delete', async () => {
    const { handler, deps, repo } = setup();
    const failure = new Error('eventbridge down');
    deps.events.transactionsChanged = async () => {
      throw failure;
    };
    const error = vi.spyOn(logger, 'error');
    const del = await handler(apiEvent('DELETE', '/transactions/t3'));
    expect(del.statusCode).toBe(204);
    expect(repo.transactions.some((t) => t.id === 't3')).toBe(false);
    expect(error).toHaveBeenCalledWith('Failed to publish TransactionsChanged', { error: failure, reason: 'DELETED', symbols: ['AAPL'] });
  });

  it('DELETE decodes the id from the path', async () => {
    const { handler, repo } = setup();
    repo.transactions.push(txn({ id: 'a b', date: '2025-08-01', type: 'BUY', symbol: 'VWRL.AS', quantity: 1, price: 1 }));
    expect((await handler(apiEvent('DELETE', '/api/transactions/a%20b'))).statusCode).toBe(204);
    expect(repo.transactions.some((t) => t.id === 'a b')).toBe(false);
  });
});

describe('imports edge cases', () => {
  it('scopes imports per user', async () => {
    const { handler } = setup();
    const created = json(await handler(apiEvent('POST', '/imports', { body: { fileName: 'a.csv' }, sub: 'alice' })));
    expect((await handler(apiEvent('GET', `/imports/${created.importId}`, { sub: 'alice' }))).statusCode).toBe(200);
    const other = await handler(apiEvent('GET', `/imports/${created.importId}`, { sub: 'bob' }));
    expect(other.statusCode).toBe(404);
    expect(json(other).error.message).toBe(`Import ${created.importId} not found`);
  });

  it('signs the upload for the user-scoped key with the documented expiry', async () => {
    const { handler, deps } = setup();
    const sign = vi.spyOn(deps.signer, 'signCsvUpload');
    await handler(apiEvent('POST', '/imports', { body: { fileName: 'a.csv' }, sub: 'alice' }));
    expect(sign).toHaveBeenCalledWith('imports/alice/uuid-1.csv', 300);
  });

  it('rejects an empty body and invalid import requests with a specific message', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('POST', '/imports'))).statusCode).toBe(400);
    const res = await handler(apiEvent('POST', '/imports', { body: { name: 'x.csv' } }));
    expect(res.statusCode).toBe(400);
    expect(json(res).error.message).toBe('Invalid import request');
  });
});
