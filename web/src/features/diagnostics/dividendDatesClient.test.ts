import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { dividendDates } from '../../test/dividendDates';
import { checkDividendsNow, fetchDividendDates } from './dividendDatesClient';

describe('fetchDividendDates', () => {
  it('returns the report', async () => {
    server.use(http.get(api('/diagnostics/dividend-dates'), () => HttpResponse.json(dividendDates())));
    expect(await fetchDividendDates()).toEqual(dividendDates());
  });

  it.each([401, 403, 404, 405])('treats %i as "not exposed"', async (status) => {
    server.use(http.get(api('/diagnostics/dividend-dates'), () => new HttpResponse(null, { status })));
    expect(await fetchDividendDates()).toBeNull();
  });

  it('treats a body that is not a report as "not exposed"', async () => {
    server.use(http.get(api('/diagnostics/dividend-dates'), () => new HttpResponse('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    expect(await fetchDividendDates()).toBeNull();
    server.use(http.get(api('/diagnostics/dividend-dates'), () => HttpResponse.json({ symbols: 'many' })));
    expect(await fetchDividendDates()).toBeNull();
  });

  it('rejects on a server failure', async () => {
    server.use(http.get(api('/diagnostics/dividend-dates'), () => new HttpResponse(null, { status: 500 })));
    await expect(fetchDividendDates()).rejects.toThrow('status 500');
  });
});

describe('checkDividendsNow', () => {
  it('is accepted on 202', async () => {
    server.use(http.post(api('/diagnostics/dividend-dates/refresh'), () => HttpResponse.json({ accepted: true }, { status: 202 })));
    expect(await checkDividendsNow()).toEqual({ accepted: true });
  });

  it.each([429, 503, 404])('returns the reason of a %i refusal', async (status) => {
    server.use(http.post(api('/diagnostics/dividend-dates/refresh'), () => HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'Allowance spent' } }, { status })));
    expect(await checkDividendsNow()).toEqual({ accepted: false, message: 'Allowance spent' });
  });

  it('falls back to the status when a refusal has no readable message', async () => {
    server.use(http.post(api('/diagnostics/dividend-dates/refresh'), () => new HttpResponse('nope', { status: 429 })));
    expect(await checkDividendsNow()).toEqual({ accepted: false, message: 'The check was refused (status 429).' });
  });

  it('rejects on a server failure', async () => {
    server.use(http.post(api('/diagnostics/dividend-dates/refresh'), () => new HttpResponse(null, { status: 500 })));
    await expect(checkDividendsNow()).rejects.toThrow('status 500');
  });
});
