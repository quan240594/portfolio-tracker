import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { MAX_PORTFOLIOS } from '@portfolio/shared';
import { createHandler } from './lambda/handler.js';
import { logger } from '@portfolio/platform';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);
const NOW = '2026-06-15T12:00:00.000Z';

/** Two portfolios: `default` (EUR ETF + USD AAPL) and `broker` (USD MSFT). */
function setup() {
  const ctx = fakeDeps();
  const { repo } = ctx;
  repo.portfolios = [
    portfolio({ portfolioId: 'broker', name: 'Broker', createdAt: '2025-02-01T00:00:00.000Z', updatedAt: '2025-02-01T00:00:00.000Z' }),
    portfolio({ portfolioId: 'default', name: 'Main portfolio' }),
    portfolio({ portfolioId: 'default', userId: 'someone-else', name: 'Other main' }),
  ];
  repo.transactions = [
    txn({ id: 't1', date: '2025-01-10', type: 'BUY', symbol: 'VWRL.AS', quantity: 10, price: 100 }),
    txn({ id: 't2', date: '2025-03-03', type: 'BUY', symbol: 'AAPL', quantity: 5, price: 150, currency: 'USD' }),
    txn({ id: 'b1', portfolioId: 'broker', date: '2025-05-02', type: 'BUY', symbol: 'MSFT', quantity: 2, price: 400, currency: 'USD' }),
    txn({ id: 'b2', portfolioId: 'broker', date: '2025-06-02', type: 'BUY', symbol: 'AAPL', quantity: 2, price: 180, currency: 'USD' }),
  ];
  repo.quotes = {
    'VWRL.AS': { symbol: 'VWRL.AS', price: 120, previousClose: 118, currency: 'EUR', asOf: NOW, source: 'test' },
    AAPL: { symbol: 'AAPL', price: 220, previousClose: 215, currency: 'USD', asOf: NOW, source: 'test' },
    MSFT: { symbol: 'MSFT', price: 440, previousClose: 440, currency: 'USD', asOf: NOW, source: 'test' },
  };
  repo.fx = { base: 'EUR', rates: { USD: 1.1 }, asOf: NOW };
  return { ...ctx, handler: createHandler(() => ctx.deps) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /portfolios', () => {
  it('lists the user portfolios sorted by createdAt', async () => {
    const { handler, repo } = setup();
    repo.portfolios.push(portfolio({ portfolioId: 'aaa', name: 'Same time', createdAt: '2025-02-01T00:00:00.000Z' }));
    const res = await handler(apiEvent('GET', '/portfolios'));
    expect(res.statusCode).toBe(200);
    expect(json(res).portfolios.map((p: { portfolioId: string }) => p.portfolioId)).toEqual(['default', 'aaa', 'broker']);
  });

  it('creates the default portfolio for a user without any, exactly once', async () => {
    const { handler, repo } = setup();
    const res = await handler(apiEvent('GET', '/portfolios', { sub: 'new-user' }));
    const expected = { portfolioId: 'default', userId: 'new-user', name: 'Main portfolio', createdAt: NOW, updatedAt: NOW };
    expect(json(res)).toEqual({ portfolios: [expected] });
    await handler(apiEvent('GET', '/portfolios', { sub: 'new-user' }));
    expect(repo.portfolios.filter((p) => p.userId === 'new-user')).toEqual([expected]);
  });

  it('returns the concurrently created default when the conditional put loses the race', async () => {
    const { handler, repo } = setup();
    const winner = portfolio({ portfolioId: 'default', userId: 'racer', name: 'Main portfolio', createdAt: '2026-06-15T11:59:59.000Z' });
    vi.spyOn(repo, 'createPortfolio').mockImplementationOnce(async () => {
      repo.portfolios.push(winner);
      return false;
    });
    expect(json(await handler(apiEvent('GET', '/portfolios', { sub: 'racer' })))).toEqual({ portfolios: [winner] });
  });

  it('falls back to the portfolio it tried to create when the winner cannot be read back', async () => {
    const { handler, repo } = setup();
    vi.spyOn(repo, 'createPortfolio').mockResolvedValueOnce(false);
    const body = json(await handler(apiEvent('GET', '/portfolios', { sub: 'racer' })));
    expect(body.portfolios).toEqual([expect.objectContaining({ portfolioId: 'default', userId: 'racer' })]);
  });
});

describe('POST /portfolios', () => {
  it('creates a portfolio with a generated id and a trimmed name', async () => {
    const { handler, repo } = setup();
    const res = await handler(apiEvent('POST', '/portfolios', { body: { name: '  Trading 212 ' } }));
    expect(res.statusCode).toBe(201);
    const expected = { portfolioId: 'uuid-1', userId: 'demo', name: 'Trading 212', createdAt: NOW, updatedAt: NOW };
    expect(json(res)).toEqual(expected);
    expect(repo.portfolios).toContainEqual(expected);
  });

  it('rejects a duplicate name case-insensitively with 409 CONFLICT', async () => {
    const { handler, repo } = setup();
    const res = await handler(apiEvent('POST', '/portfolios', { body: { name: ' main PORTFOLIO' } }));
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toEqual({ code: 'CONFLICT', message: 'A portfolio named "Main portfolio" already exists', details: { portfolioId: 'default' } });
    expect(repo.portfolios).toHaveLength(3);
  });

  it('allows a name that another user already uses', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('POST', '/portfolios', { body: { name: 'Broker' }, sub: 'someone-else' }))).statusCode).toBe(201);
  });

  it(`rejects more than ${MAX_PORTFOLIOS} portfolios with 422`, async () => {
    const { handler, repo } = setup();
    for (let i = repo.portfolios.length - 1; i < MAX_PORTFOLIOS; i++) repo.portfolios.push(portfolio({ portfolioId: `p${i}`, name: `P${i}` }));
    const res = await handler(apiEvent('POST', '/portfolios', { body: { name: 'One too many' } }));
    expect(res.statusCode).toBe(422);
    expect(json(res).error).toEqual({ code: 'UNPROCESSABLE', message: `A user can have at most ${MAX_PORTFOLIOS} portfolios` });
  });

  it('validates the body', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('POST', '/portfolios'))).statusCode).toBe(400);
    const res = await handler(apiEvent('POST', '/portfolios', { body: { name: '   ' } }));
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid portfolio' });
  });

  it('reports a generated id collision as 409', async () => {
    const { handler, repo } = setup();
    vi.spyOn(repo, 'createPortfolio').mockResolvedValueOnce(false);
    const res = await handler(apiEvent('POST', '/portfolios', { body: { name: 'New' } }));
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('CONFLICT');
  });
});

describe('PATCH /portfolios/{id}', () => {
  it('renames the portfolio and bumps updatedAt', async () => {
    const { handler, repo } = setup();
    const res = await handler(apiEvent('PATCH', '/portfolios/broker', { body: { name: 'Trading 212' } }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ portfolioId: 'broker', userId: 'demo', name: 'Trading 212', createdAt: '2025-02-01T00:00:00.000Z', updatedAt: NOW });
    expect(repo.portfolios.find((p) => p.portfolioId === 'broker')!.name).toBe('Trading 212');
  });

  it('allows changing only the case of its own name', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('PATCH', '/portfolios/broker', { body: { name: 'BROKER' } }));
    expect(res.statusCode).toBe(200);
    expect(json(res).name).toBe('BROKER');
  });

  it('rejects a name used by another portfolio with 409', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('PATCH', '/portfolios/broker', { body: { name: 'MAIN portfolio' } }));
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('CONFLICT');
  });

  it('returns 404 for unknown, foreign and malformed ids', async () => {
    const { handler } = setup();
    for (const path of ['/portfolios/nope', '/portfolios/Bad%23Id']) {
      const res = await handler(apiEvent('PATCH', path, { body: { name: 'x' } }));
      expect(res.statusCode).toBe(404);
      expect(json(res).error.code).toBe('NOT_FOUND');
    }
    expect((await handler(apiEvent('PATCH', '/portfolios/broker', { body: { name: 'x' }, sub: 'someone-else' }))).statusCode).toBe(404);
  });

  it('validates the body', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('PATCH', '/portfolios/broker', { body: { name: '' } }))).statusCode).toBe(400);
  });

  it('returns 404 when the portfolio disappears before the update', async () => {
    const { handler, repo } = setup();
    vi.spyOn(repo, 'renamePortfolio').mockResolvedValueOnce(null);
    expect((await handler(apiEvent('PATCH', '/portfolios/broker', { body: { name: 'x' } }))).statusCode).toBe(404);
  });
});

describe('DELETE /portfolios/{id}', () => {
  it('deletes an empty portfolio without publishing an event', async () => {
    const { handler, repo, events } = setup();
    repo.portfolios.push(portfolio({ portfolioId: 'empty', name: 'Empty' }));
    const res = await handler(apiEvent('DELETE', '/portfolios/empty'));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(repo.portfolios.some((p) => p.portfolioId === 'empty')).toBe(false);
    expect(events.published).toEqual([]);
  });

  it('refuses a portfolio with transactions with 409 PORTFOLIO_NOT_EMPTY', async () => {
    const { handler, repo } = setup();
    for (const query of [undefined, { force: 'false' }, { force: '1' }]) {
      const res = await handler(apiEvent('DELETE', '/portfolios/broker', { query }));
      expect(res.statusCode).toBe(409);
      expect(json(res).error).toMatchObject({ code: 'PORTFOLIO_NOT_EMPTY', details: { transactionCount: 2 } });
    }
    expect(repo.portfolios.some((p) => p.portfolioId === 'broker')).toBe(true);
    expect(repo.transactions).toHaveLength(4);
  });

  it('cascades with force=true and publishes DELETED with the removed symbols', async () => {
    const { handler, repo, events } = setup();
    repo.transactions.push(txn({ id: 'b3', portfolioId: 'broker', date: '2025-07-01', type: 'SELL', symbol: 'MSFT', quantity: 1, price: 420, currency: 'USD' }));
    const res = await handler(apiEvent('DELETE', '/portfolios/broker', { query: { force: 'true' } }));
    expect(res.statusCode).toBe(204);
    expect(repo.portfolios.some((p) => p.userId === 'demo' && p.portfolioId === 'broker')).toBe(false);
    expect(repo.transactions.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(events.published).toEqual([{ userId: 'demo', portfolioId: 'broker', symbols: ['AAPL', 'MSFT'], reason: 'DELETED' }]);
  });

  it('keeps the portfolio when the cascade fails so the delete can be retried', async () => {
    const { handler, repo } = setup();
    vi.spyOn(repo, 'deleteTransactions').mockRejectedValueOnce(new Error('ddb down'));
    expect((await handler(apiEvent('DELETE', '/portfolios/broker', { query: { force: 'true' } }))).statusCode).toBe(500);
    expect(repo.portfolios.some((p) => p.portfolioId === 'broker')).toBe(true);
  });

  it('still succeeds when publishing the cascade event fails', async () => {
    const { handler, deps } = setup();
    const failure = new Error('eventbridge down');
    deps.events.transactionsChanged = async () => {
      throw failure;
    };
    const error = vi.spyOn(logger, 'error');
    expect((await handler(apiEvent('DELETE', '/portfolios/broker', { query: { force: 'true' } }))).statusCode).toBe(204);
    expect(error).toHaveBeenCalledWith('Failed to publish TransactionsChanged', {
      error: failure,
      reason: 'DELETED',
      portfolioId: 'broker',
      symbols: ['AAPL', 'MSFT'],
    });
  });

  it('refuses to delete the only portfolio with 409 LAST_PORTFOLIO, even with force', async () => {
    const { handler, repo } = setup();
    repo.portfolios = repo.portfolios.filter((p) => p.portfolioId !== 'broker');
    const res = await handler(apiEvent('DELETE', '/portfolios/default', { query: { force: 'true' } }));
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toEqual({ code: 'LAST_PORTFOLIO', message: 'Cannot delete the only portfolio' });
    expect(repo.transactions).toHaveLength(4);
  });

  it('allows deleting the default portfolio when others exist', async () => {
    const { handler, repo } = setup();
    expect((await handler(apiEvent('DELETE', '/portfolios/default', { query: { force: 'true' } }))).statusCode).toBe(204);
    await expect(repo.listPortfolios('demo')).resolves.toEqual([expect.objectContaining({ portfolioId: 'broker' })]);
    // The default is not re-created on first use once the user has other portfolios.
    expect((await handler(apiEvent('GET', '/portfolio', { query: { portfolioId: 'default' } }))).statusCode).toBe(404);
    expect(json(await handler(apiEvent('GET', '/portfolios'))).portfolios).toHaveLength(1);
  });

  it('returns 404 for unknown and malformed ids', async () => {
    const { handler } = setup();
    expect((await handler(apiEvent('DELETE', '/portfolios/nope'))).statusCode).toBe(404);
    expect((await handler(apiEvent('DELETE', '/portfolios/NOPE'))).statusCode).toBe(404);
  });
});

describe('read endpoints scoped by ?portfolioId=', () => {
  it('combines every portfolio when the scope is omitted or "all"', async () => {
    const { handler } = setup();
    for (const query of [undefined, { portfolioId: 'all' }]) {
      const body = json(await handler(apiEvent('GET', '/holdings', { query })));
      expect(body.holdings.map((h: { symbol: string; quantity: number }) => [h.symbol, h.quantity])).toEqual([
        ['AAPL', 7],
        ['VWRL.AS', 10],
        ['MSFT', 2],
      ]);
    }
  });

  it('restricts holdings, summary, allocation and dividends to one portfolio', async () => {
    const { handler, repo } = setup();
    const query = { portfolioId: 'broker' };
    const holdings = json(await handler(apiEvent('GET', '/holdings', { query }))).holdings;
    expect(holdings.map((h: { symbol: string; quantity: number }) => [h.symbol, h.quantity])).toEqual([
      ['MSFT', 2],
      ['AAPL', 2],
    ]);
    expect(json(await handler(apiEvent('GET', '/portfolio', { query })))).toMatchObject({ holdingsCount: 2, totalValue: 1200 });
    const alloc = json(await handler(apiEvent('GET', '/allocation', { query: { ...query, by: 'currency' } })));
    expect(alloc.slices).toEqual([expect.objectContaining({ key: 'USD', weight: 1 })]);
    repo.dividendEvents = [{ symbol: 'VWRL.AS', exDate: '2026-07-01', amount: 1, currency: 'EUR' }];
    expect(json(await handler(apiEvent('GET', '/dividends', { query }))).upcoming).toEqual([]);
    expect(json(await handler(apiEvent('GET', '/dividends'))).upcoming).toHaveLength(1);
  });

  it('lists only the transactions of the selected portfolio', async () => {
    const { handler } = setup();
    const ids = (query?: Record<string, string>) =>
      handler(apiEvent('GET', '/transactions', { query })).then((r) => json(r).transactions.map((t: { id: string }) => t.id));
    expect(await ids({ portfolioId: 'broker' })).toEqual(['b2', 'b1']);
    expect(await ids({ portfolioId: 'default' })).toEqual(['t2', 't1']);
    expect(await ids()).toEqual(['b2', 'b1', 't2', 't1']);
  });

  it('loads FX fixings from the earliest transaction in scope', async () => {
    const { handler, repo } = setup();
    const getFxHistory = vi.spyOn(repo, 'getFxHistory');
    await handler(apiEvent('GET', '/history', { query: { portfolioId: 'broker', range: 'ALL' } }));
    expect(getFxHistory).toHaveBeenLastCalledWith('EUR', '2025-04-25', '2026-06-15');
    await handler(apiEvent('GET', '/history', { query: { range: 'ALL' } }));
    expect(getFxHistory).toHaveBeenLastCalledWith('EUR', '2025-01-03', '2026-06-15');
    getFxHistory.mockClear();
    // A portfolio holding only base-currency instruments skips the fixings query, whatever the other portfolios hold.
    repo.portfolios.push(portfolio({ portfolioId: 'eur', name: 'EUR' }));
    repo.transactions.push(txn({ id: 'e1', portfolioId: 'eur', date: '2025-09-01', type: 'BUY', symbol: 'VWRL.AS', quantity: 1, price: 100 }));
    await handler(apiEvent('GET', '/portfolio', { query: { portfolioId: 'eur' } }));
    expect(getFxHistory).not.toHaveBeenCalled();
  });

  it('starts the history at the first transaction of the selected portfolio', async () => {
    const { handler } = setup();
    const { points } = json(await handler(apiEvent('GET', '/history', { query: { portfolioId: 'broker', range: 'ALL' } })));
    expect(points[0].date).toBe('2025-05-02');
  });

  it.each(['/portfolio', '/holdings', '/allocation', '/history', '/dividends', '/transactions'])(
    'GET %s returns 404 for an unknown portfolio and 400 for a malformed id',
    async (path) => {
      const { handler } = setup();
      const unknown = await handler(apiEvent('GET', path, { query: { portfolioId: 'nope' } }));
      expect(unknown.statusCode).toBe(404);
      expect(json(unknown).error).toEqual({ code: 'NOT_FOUND', message: 'Portfolio nope not found' });
      const foreign = await handler(apiEvent('GET', path, { query: { portfolioId: 'broker' }, sub: 'someone-else' }));
      expect(foreign.statusCode).toBe(404);
      const bad = await handler(apiEvent('GET', path, { query: { portfolioId: 'Bad#' } }));
      expect(bad.statusCode).toBe(400);
      expect(json(bad).error.details[0].path).toEqual(['portfolioId']);
    },
  );

  it('creates the default portfolio on first use by a new user', async () => {
    const { handler, repo } = setup();
    const res = await handler(apiEvent('GET', '/portfolio', { query: { portfolioId: 'default' }, sub: 'new-user' }));
    expect(res.statusCode).toBe(200);
    expect(json(res).totalValue).toBe(0);
    expect(repo.portfolios.filter((p) => p.userId === 'new-user').map((p) => p.portfolioId)).toEqual(['default']);
  });
});

describe('POST /transactions with portfolios', () => {
  const body = { portfolioId: 'broker', date: '2026-06-01', type: 'BUY', symbol: 'msft', quantity: 1, price: 400, currency: 'usd' };

  it('requires a portfolioId', async () => {
    const { handler } = setup();
    const { portfolioId: _omit, ...rest } = body;
    const res = await handler(apiEvent('POST', '/transactions', { body: rest }));
    expect(res.statusCode).toBe(400);
    expect(json(res).error.details[0].path).toEqual(['portfolioId']);
  });

  it('returns 404 for an unknown portfolio and writes nothing', async () => {
    const { handler, repo, events } = setup();
    const res = await handler(apiEvent('POST', '/transactions', { body: { ...body, portfolioId: 'nope' } }));
    expect(res.statusCode).toBe(404);
    expect(json(res).error.message).toBe('Portfolio nope not found');
    expect(repo.transactions).toHaveLength(4);
    expect(events.published).toEqual([]);
  });

  it('writes the transaction to the target portfolio and publishes its portfolioId', async () => {
    const { handler, repo, events } = setup();
    const res = await handler(apiEvent('POST', '/transactions', { body }));
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({ id: 'uuid-1', portfolioId: 'broker', symbol: 'MSFT', currency: 'USD' });
    expect(repo.transactions.at(-1)).toMatchObject({ id: 'uuid-1', portfolioId: 'broker' });
    expect(events.published).toEqual([{ userId: 'demo', portfolioId: 'broker', symbols: ['MSFT'], reason: 'CREATED' }]);
  });

  it('validates overselling against the target portfolio only', async () => {
    const { handler, repo } = setup();
    // AAPL: 5 held in default, 2 in broker -> selling 3 from broker oversells although 7 are held overall.
    const sell = { ...body, type: 'SELL', symbol: 'AAPL', quantity: 3 };
    const res = await handler(apiEvent('POST', '/transactions', { body: sell }));
    expect(res.statusCode).toBe(422);
    expect(json(res).error).toEqual({ code: 'UNPROCESSABLE', message: 'Cannot sell 3 AAPL on 2026-06-01: only 2 held' });
    expect((await handler(apiEvent('POST', '/transactions', { body: { ...sell, portfolioId: 'default' } }))).statusCode).toBe(201);
    expect(repo.transactions).toHaveLength(5);
  });

  it('a sale is not blocked by positions of other portfolios being short', async () => {
    const { handler } = setup();
    // MSFT is held only in broker; selling it there is fine even though default holds none.
    expect((await handler(apiEvent('POST', '/transactions', { body: { ...body, type: 'SELL', quantity: 2 } }))).statusCode).toBe(201);
    expect((await handler(apiEvent('POST', '/transactions', { body: { ...body, type: 'SELL', portfolioId: 'default' } }))).statusCode).toBe(422);
  });

  it('rejects a currency that differs from the one the symbol uses in any portfolio with 422', async () => {
    const { handler, repo } = setup();
    const res = await handler(apiEvent('POST', '/transactions', { body: { ...body, portfolioId: 'default', currency: 'EUR' } }));
    expect(res.statusCode).toBe(422);
    expect(json(res).error).toEqual({ code: 'UNPROCESSABLE', message: 'Mixed currencies for MSFT: USD and EUR' });
    expect(repo.transactions).toHaveLength(4);
  });

  it('ignores other users when checking currency consistency', async () => {
    const { handler } = setup();
    const res = await handler(apiEvent('POST', '/transactions', { body: { ...body, portfolioId: 'default', currency: 'EUR' }, sub: 'someone-else' }));
    expect(res.statusCode).toBe(201);
  });

  it('creates the default portfolio on first use', async () => {
    const { handler, repo } = setup();
    const res = await handler(apiEvent('POST', '/transactions', { body: { ...body, portfolioId: 'default' }, sub: 'new-user' }));
    expect(res.statusCode).toBe(201);
    expect(repo.portfolios.filter((p) => p.userId === 'new-user').map((p) => p.portfolioId)).toEqual(['default']);
  });
});

describe('DELETE /transactions/{id} with portfolios', () => {
  it('validates the remaining transactions of the transaction portfolio only', async () => {
    const { handler, repo } = setup();
    repo.transactions.push(
      txn({ id: 'd1', date: '2025-05-01', type: 'BUY', symbol: 'MSFT', quantity: 5, price: 400, currency: 'USD' }),
      txn({ id: 'b3', portfolioId: 'broker', date: '2025-07-01', type: 'SELL', symbol: 'MSFT', quantity: 2, price: 420, currency: 'USD' }),
    );
    // Without b1 the broker sale oversells, even though the default portfolio holds 5 MSFT.
    const res = await handler(apiEvent('DELETE', '/transactions/b1'));
    expect(res.statusCode).toBe(422);
    expect(repo.transactions.some((t) => t.id === 'b1')).toBe(true);
    // Deleting the default buy leaves the broker untouched.
    expect((await handler(apiEvent('DELETE', '/transactions/d1'))).statusCode).toBe(204);
  });

  it('publishes the portfolio of the deleted transaction', async () => {
    const { handler, events } = setup();
    expect((await handler(apiEvent('DELETE', '/transactions/b2'))).statusCode).toBe(204);
    expect(events.published).toEqual([{ userId: 'demo', portfolioId: 'broker', symbols: ['AAPL'], reason: 'DELETED' }]);
  });
});

describe('imports with portfolios', () => {
  it('stores the target portfolio on the import and returns it from GET /imports/{id}', async () => {
    const { handler, repo } = setup();
    const created = json(await handler(apiEvent('POST', '/imports', { body: { fileName: 'a.csv', portfolioId: 'broker' } })));
    expect(created.uploadUrl).toContain('imports/demo/uuid-1.csv');
    expect(repo.imports.get('demo/uuid-1')).toMatchObject({ portfolioId: 'broker' });
    expect(json(await handler(apiEvent('GET', '/imports/uuid-1')))).toMatchObject({ portfolioId: 'broker', status: 'PENDING' });
  });

  it('requires an existing portfolio', async () => {
    const { handler, repo } = setup();
    const missing = await handler(apiEvent('POST', '/imports', { body: { fileName: 'a.csv' } }));
    expect(missing.statusCode).toBe(400);
    expect(json(missing).error.details[0].path).toEqual(['portfolioId']);
    const unknown = await handler(apiEvent('POST', '/imports', { body: { fileName: 'a.csv', portfolioId: 'nope' } }));
    expect(unknown.statusCode).toBe(404);
    expect(repo.imports.size).toBe(0);
  });

  it('creates the default portfolio on first use', async () => {
    const { handler, repo } = setup();
    expect((await handler(apiEvent('POST', '/imports', { body: { fileName: 'a.csv', portfolioId: 'default' }, sub: 'new-user' }))).statusCode).toBe(201);
    expect(repo.portfolios.some((p) => p.userId === 'new-user' && p.portfolioId === 'default')).toBe(true);
  });
});
