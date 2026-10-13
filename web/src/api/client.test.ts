import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError, api, apiUrl } from './client';

describe('api client', () => {
  it('builds URLs against the configured base', () => {
    expect(apiUrl('/allocation', { by: 'sector', x: undefined })).toBe(`${location.origin}/api/allocation?by=sector`);
  });

  it('throws a typed ApiError from the error envelope', async () => {
    server.use(
      http.get('/api/holdings', () =>
        HttpResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Bad input', details: { f: 1 } } }, { status: 400 }),
      ),
    );
    const err = await api.getHoldings().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'Bad input', details: { f: 1 } });
  });

  it('falls back to an HTTP_<status> code for non-envelope errors', async () => {
    server.use(http.get('/api/portfolio', () => new HttpResponse('Bad gateway', { status: 502 })));
    await expect(api.getPortfolio()).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('maps network failures to NETWORK_ERROR', async () => {
    server.use(http.get('/api/dividends', () => HttpResponse.error()));
    await expect(api.getDividends()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('handles 204 No Content', async () => {
    const { transactions } = await api.listTransactions();
    await expect(api.deleteTransaction(transactions[0]!.id)).resolves.toBeUndefined();
  });
});
