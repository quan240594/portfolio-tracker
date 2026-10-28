import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { earningsDates } from '../../test/earningsDates';
import { fetchEarningsDates, refreshEarningsDates } from './earningsDatesClient';

describe('fetchEarningsDates', () => {
  it('returns the report', async () => {
    server.use(http.get(api('/diagnostics/earnings-dates'), () => HttpResponse.json(earningsDates())));
    expect(await fetchEarningsDates()).toEqual(earningsDates());
  });

  it.each([401, 403, 404, 405])('treats %i as "not exposed"', async (status) => {
    server.use(http.get(api('/diagnostics/earnings-dates'), () => new HttpResponse(null, { status })));
    expect(await fetchEarningsDates()).toBeNull();
  });

  it('treats a body that is not a report (a static host fallback, a changed contract) as "not exposed"', async () => {
    server.use(http.get(api('/diagnostics/earnings-dates'), () => new HttpResponse('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    expect(await fetchEarningsDates()).toBeNull();
    server.use(http.get(api('/diagnostics/earnings-dates'), () => HttpResponse.json({ symbols: 'many' })));
    expect(await fetchEarningsDates()).toBeNull();
  });

  it('rejects on a server failure', async () => {
    server.use(http.get(api('/diagnostics/earnings-dates'), () => new HttpResponse(null, { status: 500 })));
    await expect(fetchEarningsDates()).rejects.toThrow('status 500');
  });
});

describe('refreshEarningsDates', () => {
  it('is accepted on 202', async () => {
    server.use(http.post(api('/diagnostics/earnings-dates/refresh'), () => HttpResponse.json({ accepted: true }, { status: 202 })));
    expect(await refreshEarningsDates()).toEqual({ accepted: true });
  });

  it.each([429, 503, 404])('returns the reason of a %i refusal', async (status) => {
    server.use(http.post(api('/diagnostics/earnings-dates/refresh'), () => HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'Nearly used up' } }, { status })));
    expect(await refreshEarningsDates()).toEqual({ accepted: false, message: 'Nearly used up' });
  });

  it('falls back to the status when a refusal has no readable message', async () => {
    server.use(http.post(api('/diagnostics/earnings-dates/refresh'), () => new HttpResponse('nope', { status: 429 })));
    expect(await refreshEarningsDates()).toEqual({ accepted: false, message: 'The refresh was refused (status 429).' });
  });

  it('rejects on a server failure', async () => {
    server.use(http.post(api('/diagnostics/earnings-dates/refresh'), () => new HttpResponse(null, { status: 500 })));
    await expect(refreshEarningsDates()).rejects.toThrow('status 500');
  });
});
