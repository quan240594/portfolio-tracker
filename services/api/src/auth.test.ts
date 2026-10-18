import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { importObjectKey } from '@portfolio/shared';
import { createHandler } from './lambda/handler.js';
import type { Deps } from './deps.js';
import { apiEvent, fakeDeps, portfolio, txn } from './testing/fakes.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);

function setup(authMode: 'cognito' | 'demo') {
  const ctx = fakeDeps();
  const deps: Deps = { ...ctx.deps, config: { ...ctx.deps.config, authMode } };
  return { ...ctx, handler: createHandler(() => deps) };
}

describe('AUTH_MODE=cognito', () => {
  it('answers 401 UNAUTHENTICATED for every route when the authorizer claims are missing', async () => {
    const { handler, repo } = setup('cognito');
    repo.transactions = [txn({ id: 'demo-txn', date: '2025-01-10', type: 'BUY', symbol: 'AAPL', quantity: 1, price: 1 })];
    for (const [method, path] of [
      ['GET', '/health'],
      ['GET', '/portfolios'],
      ['GET', '/transactions'],
      ['POST', '/transactions'],
      ['DELETE', '/transactions/demo-txn'],
      ['POST', '/imports'],
      ['GET', '/portfolio'],
      ['GET', '/no-such-route'],
    ] as const) {
      const res = await handler(apiEvent(method, path));
      expect(res.statusCode, `${method} ${path}`).toBe(401);
      expect(json(res)).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    }
    expect(repo.transactions).toHaveLength(1);
    expect(repo.users.size).toBe(0);
  });

  it('serves authenticated requests and still answers CORS preflight without claims', async () => {
    const { handler } = setup('cognito');
    expect((await handler(apiEvent('GET', '/health', { sub: ALICE }))).statusCode).toBe(200);
    expect((await handler(apiEvent('OPTIONS', '/transactions'))).statusCode).toBe(204);
  });

  it('is the default when the config says nothing (fail closed)', () => {
    expect(fakeDeps().deps.config.authMode).toBe('demo'); // test fixtures opt in to demo explicitly
  });
});

describe('AUTH_MODE=demo', () => {
  it('serves requests without claims as the demo user', async () => {
    const { handler, repo } = setup('demo');
    repo.transactions = [txn({ id: 't1', date: '2025-01-10', type: 'BUY', symbol: 'AAPL', quantity: 1, price: 1, currency: 'USD' })];
    const res = await handler(apiEvent('GET', '/transactions'));
    expect(res.statusCode).toBe(200);
    expect(json(res).transactions.map((t: { id: string }) => t.id)).toEqual(['t1']);
  });
});

describe('two-user isolation (cognito mode)', () => {
  const buy = { portfolioId: 'default', date: '2026-06-01', type: 'BUY', quantity: 1, price: 100, currency: 'EUR' };

  it('keeps transactions, portfolios and summaries of different users apart', async () => {
    const { handler, repo } = setup('cognito');
    repo.portfolios = [portfolio({ userId: ALICE, portfolioId: 'default', name: 'Alice main' }), portfolio({ userId: BOB, portfolioId: 'default', name: 'Bob main' })];

    const created = await handler(apiEvent('POST', '/transactions', { sub: ALICE, body: { ...buy, symbol: 'ALICE.CO' } }));
    expect(created.statusCode).toBe(201);
    await handler(apiEvent('POST', '/transactions', { sub: BOB, body: { ...buy, symbol: 'BOB.CO' } }));

    const symbols = async (sub: string) =>
      json(await handler(apiEvent('GET', '/transactions', { sub }))).transactions.map((t: { symbol: string }) => t.symbol);
    expect(await symbols(ALICE)).toEqual(['ALICE.CO']);
    expect(await symbols(BOB)).toEqual(['BOB.CO']);
    expect(repo.transactions.map((t) => [t.userId, t.symbol])).toEqual([[ALICE, 'ALICE.CO'], [BOB, 'BOB.CO']]);

    const names = async (sub: string) => json(await handler(apiEvent('GET', '/portfolios', { sub }))).portfolios.map((p: { name: string }) => p.name);
    expect(await names(ALICE)).toEqual(['Alice main']);
    expect(await names(BOB)).toEqual(['Bob main']);

    // A user can never target another user's rows by id.
    const aliceTxnId = repo.transactions.find((t) => t.userId === ALICE)!.id;
    expect((await handler(apiEvent('DELETE', `/transactions/${aliceTxnId}`, { sub: BOB }))).statusCode).toBe(404);
    expect(repo.transactions.some((t) => t.id === aliceTxnId)).toBe(true);
    expect((await handler(apiEvent('DELETE', '/portfolios/default', { sub: BOB }))).statusCode).not.toBe(404);
    expect(repo.portfolios.some((p) => p.userId === ALICE)).toBe(true);
  });

  it('ignores a userId smuggled in the body or query string', async () => {
    const { handler, repo } = setup('cognito');
    repo.portfolios = [portfolio({ userId: ALICE, portfolioId: 'default', name: 'Alice main' })];
    await handler(apiEvent('POST', '/transactions', { sub: ALICE, body: { ...buy, symbol: 'ALICE.CO' } }));
    const res = await handler(apiEvent('GET', '/transactions', { sub: BOB, query: { userId: ALICE } }));
    expect(json(res).transactions).toEqual([]);
    await handler(apiEvent('POST', '/transactions', { sub: BOB, body: { ...buy, symbol: 'X.CO', userId: ALICE } }));
    expect(repo.transactions.filter((t) => t.userId === ALICE)).toHaveLength(1);
  });

  it('scopes imports and their S3 object keys to the caller', async () => {
    const { handler, repo } = setup('cognito');
    repo.portfolios = [portfolio({ userId: ALICE, portfolioId: 'default', name: 'A' }), portfolio({ userId: BOB, portfolioId: 'default', name: 'B' })];

    const create = async (sub: string) =>
      json(await handler(apiEvent('POST', '/imports', { sub, body: { portfolioId: 'default', fileName: 'trades.csv' } })));
    const a = await create(ALICE);
    const b = await create(BOB);

    expect(a.uploadUrl).toContain(`imports/${ALICE}/${a.importId}.csv`);
    expect(a.uploadUrl).not.toContain(BOB);
    expect(b.uploadUrl).toContain(importObjectKey(BOB, b.importId));
    expect(b.uploadUrl).not.toContain(ALICE);

    expect((await handler(apiEvent('GET', `/imports/${a.importId}`, { sub: ALICE }))).statusCode).toBe(200);
    expect((await handler(apiEvent('GET', `/imports/${a.importId}`, { sub: BOB }))).statusCode).toBe(404);
    expect((await handler(apiEvent('GET', `/imports/${b.importId}`, { sub: ALICE }))).statusCode).toBe(404);
  });
});
