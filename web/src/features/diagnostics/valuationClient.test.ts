import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { valuationReport } from '../../test/valuationReport';
import { fetchValuationReport } from './valuationClient';

describe('fetchValuationReport', () => {
  it('reads the report, asking for the given days', async () => {
    const asked: (string | null)[] = [];
    server.use(
      http.get(api('/diagnostics/valuation'), ({ request }) => {
        asked.push(new URL(request.url).searchParams.get('dates'));
        return HttpResponse.json(valuationReport());
      }),
    );
    expect(await fetchValuationReport(['2026-10-24', '2026-10-25'])).toEqual(valuationReport());
    await fetchValuationReport(undefined);
    expect(asked).toEqual(['2026-10-24,2026-10-25', null]);
  });

  it.each([401, 403, 404, 405])('treats %i as "not exposed"', async (status) => {
    server.use(http.get(api('/diagnostics/valuation'), () => new HttpResponse(null, { status })));
    expect(await fetchValuationReport(undefined)).toBeNull();
  });

  it('treats a body that is not a report as "not exposed"', async () => {
    server.use(http.get(api('/diagnostics/valuation'), () => new HttpResponse('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    expect(await fetchValuationReport(undefined)).toBeNull();
    server.use(http.get(api('/diagnostics/valuation'), () => HttpResponse.json({ days: 'many' })));
    expect(await fetchValuationReport(undefined)).toBeNull();
  });

  it('rejects on a server failure', async () => {
    server.use(http.get(api('/diagnostics/valuation'), () => new HttpResponse(null, { status: 500 })));
    await expect(fetchValuationReport(undefined)).rejects.toThrow('status 500');
  });
});
