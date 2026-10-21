import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { fetchAlarmDiagnostics } from './diagnosticsClient';
import { report } from '../../test/diagnostics';

describe('fetchAlarmDiagnostics', () => {
  it('asks for the given number of runs and returns the parsed report', async () => {
    let seen: string | null = null;
    server.use(
      http.get(api('/diagnostics/alarms'), ({ request }) => {
        seen = new URL(request.url).searchParams.get('limit');
        return HttpResponse.json(report());
      }),
    );
    expect(await fetchAlarmDiagnostics(7)).toEqual(report());
    expect(seen).toBe('7');
  });

  it.each([401, 403, 404, 405])('treats %i as "not exposed"', async (status) => {
    server.use(http.get(api('/diagnostics/alarms'), () => new HttpResponse(null, { status })));
    expect(await fetchAlarmDiagnostics(1)).toBeNull();
  });

  it('treats a body that is not a report (a static host fallback, a changed contract) as "not exposed"', async () => {
    server.use(http.get(api('/diagnostics/alarms'), () => new HttpResponse('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    expect(await fetchAlarmDiagnostics(1)).toBeNull();
    server.use(http.get(api('/diagnostics/alarms'), () => HttpResponse.json({ runs: 'many' })));
    expect(await fetchAlarmDiagnostics(1)).toBeNull();
  });

  it('rejects on a server failure', async () => {
    server.use(http.get(api('/diagnostics/alarms'), () => new HttpResponse(null, { status: 500 })));
    await expect(fetchAlarmDiagnostics(1)).rejects.toThrow('status 500');
  });
});
