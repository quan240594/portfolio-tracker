import { apiUrl } from '../api/client';

const call = (method: string, path: string, body?: unknown) =>
  fetch(apiUrl(path), {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('mock management API (mirrors services/api)', () => {
  it('404s for unknown portfolios and categories/assets', async () => {
    expect((await call('GET', '/portfolios/nope/categories')).status).toBe(404);
    expect((await call('PATCH', '/portfolios/default/categories/zzz', { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/portfolios/default/categories/zzz')).status).toBe(404);
    expect((await call('PUT', '/portfolios/default/categories/zzz/holdings', { symbols: [] })).status).toBe(404);
    expect((await call('PATCH', '/portfolios/default/assets/zzz', { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/portfolios/default/assets/zzz')).status).toBe(404);
    expect((await call('PUT', '/portfolios/default/assets/zzz/valuations', { date: '2026-01-01', value: 1 })).status).toBe(404);
    expect((await call('DELETE', '/watchlist/NOPE')).status).toBe(404);
  });

  it('validates category input, uniqueness, limits and holdings', async () => {
    expect((await call('POST', '/portfolios/default/categories', { name: '', color: '#fff', targetWeight: 1 })).status).toBe(400);
    expect((await call('POST', '/portfolios/default/categories', { name: 'core etfs', color: '#112233', targetWeight: 0 })).status).toBe(409);
    expect((await call('PATCH', '/portfolios/default/categories/cat-core', { name: 'crypto' })).status).toBe(409);
    expect((await call('PATCH', '/portfolios/default/categories/cat-core', { targetWeight: 99 })).status).toBe(422);
    expect((await call('PATCH', '/portfolios/default/categories/cat-core', {})).status).toBe(400);
    const unknown = await call('PUT', '/portfolios/default/categories/cat-core/holdings', { symbols: ['NOPE'] });
    expect(unknown.status).toBe(422);
    expect(((await json(unknown)).error as { details: { unknownSymbols: string[] } }).details.unknownSymbols).toEqual(['NOPE']);

    for (let i = 0; i < 15; i++) expect((await call('POST', '/portfolios/trading-212/categories', { name: `C${i}`, color: '#112233', targetWeight: 0 })).status).toBe(201);
    for (let i = 15; i < 20; i++) await call('POST', '/portfolios/trading-212/categories', { name: `C${i}`, color: '#112233', targetWeight: 0 });
    expect((await call('POST', '/portfolios/trading-212/categories', { name: 'one more', color: '#112233', targetWeight: 0 })).status).toBe(422);
  });

  it('validates custom assets and valuations', async () => {
    expect((await call('POST', '/portfolios/default/assets', { name: 'x' })).status).toBe(400);
    expect((await call('DELETE', '/portfolios/default/assets/asset-savings/valuations/2000-01-01')).status).toBe(404);
    const created = (await json(await call('POST', '/portfolios/default/assets', { name: 'Gold', currency: 'USD', value: 100 }))) as {
      assetId: string;
      currentValueLocal: number;
      currentValue: number;
      valuations: { date: string }[];
    };
    expect(created.currentValueLocal).toBe(100);
    expect(created.currentValue).toBeLessThan(100);
    expect((await call('DELETE', `/portfolios/default/assets/${created.assetId}/valuations/${created.valuations[0]!.date}`)).status).toBe(422);
    expect((await call('PUT', `/portfolios/default/assets/${created.assetId}/valuations`, { date: 'x', value: 1 })).status).toBe(400);
    for (let i = 0; i < 50; i++) await call('POST', '/portfolios/trading-212/assets', { name: `A${i}`, currency: 'EUR', value: 1 });
    expect((await call('POST', '/portfolios/trading-212/assets', { name: 'over', currency: 'EUR', value: 1 })).status).toBe(422);
  });

  it('validates watchlist input and limits', async () => {
    expect((await call('POST', '/watchlist', { symbol: '' })).status).toBe(400);
    expect((await call('POST', '/watchlist', { symbol: 'NVDA' })).status).toBe(409);
    for (let i = 0; i < 97; i++) expect((await call('POST', '/watchlist', { symbol: `T${i}` })).status).toBe(201);
    expect((await call('POST', '/watchlist', { symbol: 'LAST' })).status).toBe(422);
    expect((await call('DELETE', '/watchlist/t1')).status).toBe(204);
  });

  it('validates settings, rebalance queries and category allocation scope', async () => {
    expect((await call('PUT', '/portfolios/default/settings', { trackCash: 'yes' })).status).toBe(400);
    expect((await json(await call('GET', '/portfolios/trading-212/settings'))).trackCash).toBe(false);
    expect((await call('GET', '/portfolios/default/rebalance?mode=wild')).status).toBe(400);
    expect((await call('GET', '/allocation?by=category')).status).toBe(400);
    expect((await call('GET', '/allocation?by=category&portfolioId=nope')).status).toBe(404);
    expect((await call('GET', '/allocation?by=category&portfolioId=default')).status).toBe(200);
    expect((await call('GET', '/allocation?by=bogus')).status).toBe(400);
  });

  it('exports transactions for a scope and rejects unknown portfolios', async () => {
    const res = await call('GET', '/export/transactions?portfolioId=trading-212');
    expect(res.headers.get('content-disposition')).toContain('transactions-trading-212.csv');
    expect(await res.text()).toContain('SPLIT,JNJ,2');
    expect((await call('GET', '/export/transactions?portfolioId=nope')).status).toBe(404);
  });

  it('removes the management data of a deleted portfolio', async () => {
    await call('DELETE', '/portfolios/default?force=true');
    expect((await call('GET', '/portfolios/default/categories')).status).toBe(404);
  });
});
