import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { fetchAlphaVantageProbe, runAlphaVantageProbe } from './alphaVantageProbeClient';

const budget = { provider: 'Alpha Vantage', day: '2026-10-29', used: 2, limit: 25, remaining: 23, calendarUsed: 1, calendarLimit: 1 };
const result = { at: '2026-10-29T08:20:00.000Z', symbol: 'IBM', call: 'EARNINGS_ESTIMATES', outcome: 'ok', summary: 'ok: 12 quarters', quarters: 12 };
const status = { available: true, reason: null, nextAllowedAt: null, budget, last: result };

describe('fetchAlphaVantageProbe', () => {
  it('returns the status', async () => {
    server.use(http.get(api('/diagnostics/alphavantage-probe'), () => HttpResponse.json(status)));
    expect(await fetchAlphaVantageProbe()).toEqual(status);
  });

  it.each([401, 403, 404, 405])('treats %i as "not exposed"', async (code) => {
    server.use(http.get(api('/diagnostics/alphavantage-probe'), () => new HttpResponse(null, { status: code })));
    expect(await fetchAlphaVantageProbe()).toBeNull();
  });

  it('treats a body that is not a status as "not exposed"', async () => {
    server.use(http.get(api('/diagnostics/alphavantage-probe'), () => new HttpResponse('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    expect(await fetchAlphaVantageProbe()).toBeNull();
    server.use(http.get(api('/diagnostics/alphavantage-probe'), () => HttpResponse.json({ available: 'yes' })));
    expect(await fetchAlphaVantageProbe()).toBeNull();
  });

  it('rejects on a server failure', async () => {
    server.use(http.get(api('/diagnostics/alphavantage-probe'), () => new HttpResponse(null, { status: 500 })));
    await expect(fetchAlphaVantageProbe()).rejects.toThrow('status 500');
  });
});

describe('runAlphaVantageProbe', () => {
  it('returns the result of the call', async () => {
    server.use(http.post(api('/diagnostics/alphavantage-probe'), () => HttpResponse.json({ ...result, budget })));
    expect(await runAlphaVantageProbe()).toEqual({ accepted: true, result: { ...result, budget } });
  });

  it.each([429, 503, 404])('returns the reason of a %i refusal', async (code) => {
    server.use(http.post(api('/diagnostics/alphavantage-probe'), () => HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'Ask again after 09:10 UTC.' } }, { status: code })));
    expect(await runAlphaVantageProbe()).toEqual({ accepted: false, message: 'Ask again after 09:10 UTC.' });
  });

  it('falls back to the status when a refusal has no readable message', async () => {
    server.use(http.post(api('/diagnostics/alphavantage-probe'), () => new HttpResponse('nope', { status: 429 })));
    expect(await runAlphaVantageProbe()).toEqual({ accepted: false, message: 'The test was refused (status 429).' });
  });

  it('rejects on a server failure and on an answer that is not a result', async () => {
    server.use(http.post(api('/diagnostics/alphavantage-probe'), () => new HttpResponse(null, { status: 500 })));
    await expect(runAlphaVantageProbe()).rejects.toThrow('status 500');
    server.use(http.post(api('/diagnostics/alphavantage-probe'), () => HttpResponse.json({ outcome: 'ok' })));
    await expect(runAlphaVantageProbe()).rejects.toThrow('unexpected');
  });
});
