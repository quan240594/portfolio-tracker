import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { coverage, pricesStatus } from '../../test/priceCoverage';
import { fetchPriceCoverage } from './priceCoverageClient';

describe('fetchPriceCoverage', () => {
  it('returns the coverage section of the price status', async () => {
    server.use(http.get(api('/prices/status'), () => HttpResponse.json(pricesStatus())));
    expect(await fetchPriceCoverage()).toEqual(coverage());
  });

  it.each([401, 403, 404, 405])('treats %i as "not exposed"', async (status) => {
    server.use(http.get(api('/prices/status'), () => new HttpResponse(null, { status })));
    expect(await fetchPriceCoverage()).toBeNull();
  });

  it('treats a Hub without the section, or one that could not read it, as "not exposed"', async () => {
    server.use(http.get(api('/prices/status'), () => HttpResponse.json({ state: 'ok', sources: [] })));
    expect(await fetchPriceCoverage()).toBeNull();
    server.use(http.get(api('/prices/status'), () => HttpResponse.json(pricesStatus(null))));
    expect(await fetchPriceCoverage()).toBeNull();
  });

  it('treats a body that is not a status (a static host fallback, a changed contract) as "not exposed"', async () => {
    server.use(http.get(api('/prices/status'), () => new HttpResponse('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    expect(await fetchPriceCoverage()).toBeNull();
    server.use(http.get(api('/prices/status'), () => HttpResponse.json({ history: { symbols: 'many' } })));
    expect(await fetchPriceCoverage()).toBeNull();
  });

  it('rejects on a server failure', async () => {
    server.use(http.get(api('/prices/status'), () => new HttpResponse(null, { status: 500 })));
    await expect(fetchPriceCoverage()).rejects.toThrow('status 500');
  });
});
