import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { setAuthTokenHooks } from '../features/auth/tokenHooks';
import { ApiError } from './client';
import { calendarApi, filenameFromDisposition } from './calendarClient';

afterEach(() => setAuthTokenHooks(undefined));

describe('calendarApi.get', () => {
  it('sends the range, filters and portfolio scope', async () => {
    let url = new URL('http://x');
    server.use(
      http.get('/api/calendar', ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ events: [] });
      }),
    );
    await calendarApi.get('usd', { from: '2026-10-01', to: '2026-10-31', types: ['EARNINGS', 'SPLIT'], status: ['PAID'], scope: 'holdings' });
    expect(Object.fromEntries(url.searchParams)).toEqual({ portfolioId: 'usd', from: '2026-10-01', to: '2026-10-31', types: 'EARNINGS,SPLIT', status: 'PAID', scope: 'holdings' });
  });

  it('omits the portfolio for the combined view and empty lists', async () => {
    let url = new URL('http://x');
    server.use(
      http.get('/api/calendar', ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json({ events: [] });
      }),
    );
    await calendarApi.get('all', { from: '2026-10-01', types: [], status: undefined });
    expect(Object.fromEntries(url.searchParams)).toEqual({ from: '2026-10-01' });
  });
});

describe('calendarApi.downloadIcs', () => {
  const ics = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';

  it('returns the document and the file name from Content-Disposition, sending the token', async () => {
    setAuthTokenHooks({ getToken: () => Promise.resolve('tok'), onUnauthorized: vi.fn() });
    let headers = new Headers();
    let url = new URL('http://x');
    server.use(
      http.get('/api/calendar.ics', ({ request }) => {
        headers = request.headers;
        url = new URL(request.url);
        return new HttpResponse(ics, { headers: { 'content-type': 'text/calendar', 'content-disposition': 'attachment; filename="portfolio-calendar-a_b.ics"' } });
      }),
    );
    const result = await calendarApi.downloadIcs('p1', { from: '2026-10-01', to: '2026-10-31', types: ['EARNINGS'] });
    expect(result).toEqual({ fileName: 'portfolio-calendar-a_b.ics', text: ics });
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('accept')).toBe('text/calendar');
    expect(url.searchParams.get('portfolioId')).toBe('p1');
    expect(url.searchParams.get('types')).toBe('EARNINGS');
  });

  it('falls back to a default file name', async () => {
    server.use(http.get('/api/calendar.ics', () => new HttpResponse(ics)));
    await expect(calendarApi.downloadIcs('all', {})).resolves.toMatchObject({ fileName: 'portfolio-calendar.ics' });
  });

  it('turns the error envelope into an ApiError and signs out on 401', async () => {
    const onUnauthorized = vi.fn();
    setAuthTokenHooks({ getToken: () => Promise.resolve(undefined), onUnauthorized });
    server.use(http.get('/api/calendar.ics', () => HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required', details: [1] } }, { status: 401 })));
    const err = await calendarApi.downloadIcs('all', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'UNAUTHENTICATED', message: 'Authentication required', details: [1] });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('handles envelopes without a code and non-JSON failures', async () => {
    server.use(http.get('/api/calendar.ics', () => HttpResponse.json({ error: { message: 'Nope' } }, { status: 400 })));
    await expect(calendarApi.downloadIcs('all', {})).rejects.toMatchObject({ code: 'HTTP_400', message: 'Nope' });
    server.use(http.get('/api/calendar.ics', () => new HttpResponse('<html>', { status: 502, statusText: 'Bad Gateway' })));
    await expect(calendarApi.downloadIcs('all', {})).rejects.toMatchObject({ code: 'HTTP_502', message: 'Bad Gateway' });
    server.use(http.get('/api/calendar.ics', () => HttpResponse.json({ error: { message: 5 } }, { status: 500, statusText: 'Server Error' })));
    await expect(calendarApi.downloadIcs('all', {})).rejects.toMatchObject({ code: 'HTTP_500', message: 'Server Error' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 418 }));
    await expect(calendarApi.downloadIcs('all', {})).rejects.toMatchObject({ message: 'Request failed with status 418' });
  });

  it('maps network failures and rethrows aborts', async () => {
    server.use(http.get('/api/calendar.ics', () => HttpResponse.error()));
    await expect(calendarApi.downloadIcs('all', {})).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(calendarApi.downloadIcs('all', {})).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('filenameFromDisposition', () => {
  it('extracts quoted and bare file names', () => {
    expect(filenameFromDisposition('attachment; filename="a b.ics"')).toBe('a b.ics');
    expect(filenameFromDisposition('attachment; filename=plain.ics')).toBe('plain.ics');
    expect(filenameFromDisposition('attachment')).toBe('portfolio-calendar.ics');
    expect(filenameFromDisposition(null)).toBe('portfolio-calendar.ics');
  });
});
