import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { setAuthTokenHooks } from '../features/auth/tokenHooks';
import { getBudgetNotice, reportBudgetError, resetBudgetNotice } from '../features/usage/budgetSignal';
import { budgetExhausted, budgetUnavailable } from '../test/usage';
import { ApiError, api, apiUrl, errorMessage, request, requestText, uploadCsv } from './client';

afterEach(() => setAuthTokenHooks(undefined));

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
    const err = await api.getHoldings('all').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'Bad input', details: { f: 1 } });
  });

  it('falls back to an HTTP_<status> code for non-envelope errors', async () => {
    server.use(http.get('/api/portfolio', () => new HttpResponse('Bad gateway', { status: 502 })));
    await expect(api.getPortfolio('all')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('maps network failures to NETWORK_ERROR', async () => {
    server.use(http.get('/api/dividends', () => HttpResponse.error()));
    await expect(api.getDividends('all')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('handles 204 No Content', async () => {
    const { transactions } = await api.listTransactions('all');
    await expect(api.deleteTransaction(transactions[0]!.id)).resolves.toBeUndefined();
  });

  it('falls back to the status text or a generic message for non-JSON error bodies', async () => {
    server.use(http.get('/api/holdings', () => new HttpResponse('<html>oops</html>', { status: 500, statusText: 'Internal Server Error' })));
    await expect(api.getHoldings('all')).rejects.toMatchObject({ status: 500, code: 'HTTP_500', message: 'Internal Server Error' });

    // MSW always fills in a status text, so stub fetch to simulate a proxy that sends none.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 418 }));
    await expect(api.getHoldings('all')).rejects.toMatchObject({ status: 418, code: 'HTTP_418', message: 'Request failed with status 418' });
  });

  it('ignores malformed error envelopes', async () => {
    server.use(http.get('/api/holdings', () => HttpResponse.json({ error: null }, { status: 400, statusText: 'Bad Request' })));
    await expect(api.getHoldings('all')).rejects.toMatchObject({ code: 'HTTP_400', message: 'Bad Request' });
    server.use(http.get('/api/holdings', () => HttpResponse.json({ error: { code: 'X', message: 42 } }, { status: 400, statusText: 'Bad Request' })));
    await expect(api.getHoldings('all')).rejects.toMatchObject({ code: 'HTTP_400' });
    server.use(http.get('/api/holdings', () => HttpResponse.json(['nope'], { status: 400, statusText: 'Bad Request' })));
    await expect(api.getHoldings('all')).rejects.toMatchObject({ code: 'HTTP_400' });
  });

  it('rejects invalid JSON in successful responses', async () => {
    server.use(http.get('/api/portfolio', () => new HttpResponse('not json', { status: 200 })));
    await expect(api.getPortfolio('all')).rejects.toMatchObject({ status: 200, code: 'INVALID_RESPONSE', message: 'The server returned an invalid response.' });
  });

  it('returns undefined for an empty 200 body', async () => {
    server.use(http.get('/api/portfolio', () => new HttpResponse(null, { status: 200 })));
    await expect(api.getPortfolio('all')).resolves.toBeUndefined();
  });

  it('re-throws aborts untouched', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await api.getPortfolio('all', controller.signal).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ name: 'AbortError' });
  });

  it('sends JSON bodies and query parameters', async () => {
    let seen: { contentType: string | null; accept: string | null; body: unknown } | undefined;
    server.use(
      http.post('/api/imports', async ({ request: req }) => {
        seen = { contentType: req.headers.get('content-type'), accept: req.headers.get('accept'), body: await req.json() };
        return HttpResponse.json({ importId: 'i1', uploadUrl: 'http://localhost/u', expiresInSeconds: 60 }, { status: 201 });
      }),
    );
    await expect(api.createImport({ fileName: 'a.csv', portfolioId: 'default' })).resolves.toMatchObject({ importId: 'i1' });
    expect(seen).toEqual({ contentType: 'application/json', accept: 'application/json', body: { fileName: 'a.csv', portfolioId: 'default' } });

    const history = await api.getHistory('all', '3M');
    expect(history.range).toBe('3M');
    const allocation = await api.getAllocation('all', 'currency');
    expect(allocation.by).toBe('currency');
  });

  it('does not send a Content-Type for body-less requests', async () => {
    let contentType: string | null = 'unset';
    server.use(
      http.get('/api/health', ({ request: req }) => {
        contentType = req.headers.get('content-type');
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    await expect(request('GET', '/health')).resolves.toEqual({ status: 'ok' });
    expect(contentType).toBeNull();
  });

  it('URL-encodes path ids', async () => {
    const paths: string[] = [];
    server.use(
      http.get('/api/imports/:id', ({ request: req }) => {
        paths.push(new URL(req.url).pathname);
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Import not found' } }, { status: 404 });
      }),
    );
    await expect(api.getImport('a/b c')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(paths).toEqual(['/api/imports/a%2Fb%20c']);
  });

  it('supports an absolute API base URL from the environment', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/v1///');
    vi.resetModules();
    try {
      const mod = await import('./client');
      expect(mod.apiUrl('/holdings', { a: 'b' })).toBe('https://api.example.com/v1/holdings?a=b');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('uploadCsv', () => {
  const URL_ = 'http://localhost/__upload/x';

  it('PUTs the file text as text/csv', async () => {
    let seen: { method: string; type: string | null; body: string } | undefined;
    server.use(
      http.put(URL_, async ({ request: req }) => {
        seen = { method: req.method, type: req.headers.get('content-type'), body: await req.text() };
        return new HttpResponse(null, { status: 200 });
      }),
    );
    await uploadCsv(URL_, new File(['a,b\n1,2\n'], 'x.csv'));
    expect(seen).toEqual({ method: 'PUT', type: 'text/csv', body: 'a,b\n1,2\n' });
  });

  it('reads blobs via Blob.text() when available', async () => {
    let body = '';
    server.use(
      http.put(URL_, async ({ request: req }) => {
        body = await req.text();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const blob = { text: () => Promise.resolve('via text()') } as unknown as Blob;
    await uploadCsv(URL_, blob);
    expect(body).toBe('via text()');
  });

  it('maps unreadable files to FILE_READ_FAILED', async () => {
    const rejecting = { text: () => Promise.reject(new Error('io')) } as unknown as Blob;
    await expect(uploadCsv(URL_, rejecting)).rejects.toMatchObject({ code: 'FILE_READ_FAILED', message: 'The selected file could not be read.' });
  });

  it('reports HTTP failures from storage', async () => {
    server.use(http.put(URL_, () => new HttpResponse('SignatureDoesNotMatch', { status: 403 })));
    await expect(uploadCsv(URL_, new File(['a'], 'x.csv'))).rejects.toMatchObject({
      status: 403,
      code: 'UPLOAD_FAILED',
      message: 'Uploading the file failed (HTTP 403).',
    });
  });

  it('reports network failures during upload', async () => {
    server.use(http.put(URL_, () => HttpResponse.error()));
    await expect(uploadCsv(URL_, new File(['a'], 'x.csv'))).rejects.toMatchObject({
      status: 0,
      code: 'UPLOAD_FAILED',
      message: 'Uploading the file failed. Check your connection and try again.',
    });
  });
});

describe('authorization', () => {
  const signIn = (onUnauthorized = vi.fn()) => setAuthTokenHooks({ getToken: () => Promise.resolve('id-token-123'), onUnauthorized });

  it('sends the bearer token on JSON requests only when signed in', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get('/api/health', ({ request: req }) => {
        seen.push(req.headers.get('authorization'));
        return HttpResponse.json({ status: 'ok' });
      }),
    );
    await request('GET', '/health');
    signIn();
    await request('GET', '/health');
    expect(seen).toEqual([null, 'Bearer id-token-123']);
  });
});

describe('requestText', () => {
  const csv = 'date,type\n2026-01-01,BUY\n';

  it('sends the bearer token, the Accept type and the query, and returns the text and headers', async () => {
    setAuthTokenHooks({ getToken: () => Promise.resolve('id-token-123'), onUnauthorized: vi.fn() });
    let seen: { auth: string | null; accept: string | null; portfolioId: string | null } | undefined;
    server.use(
      http.get('/api/export/transactions', ({ request: req }) => {
        seen = { auth: req.headers.get('authorization'), accept: req.headers.get('accept'), portfolioId: new URL(req.url).searchParams.get('portfolioId') };
        return new HttpResponse(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="t.csv"' } });
      }),
    );
    const res = await requestText('/export/transactions', { accept: 'text/csv', query: { portfolioId: 'p1' } });
    expect(res.text).toBe(csv);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="t.csv"');
    expect(seen).toEqual({ auth: 'Bearer id-token-123', accept: 'text/csv', portfolioId: 'p1' });
  });

  it('sends no Authorization header without a token (demo / mock mode)', async () => {
    let auth: string | null = 'unset';
    server.use(
      http.get('/api/export/transactions', ({ request: req }) => {
        auth = req.headers.get('authorization');
        return new HttpResponse(csv);
      }),
    );
    await expect(requestText('/export/transactions', { accept: 'text/csv' })).resolves.toMatchObject({ text: csv });
    expect(auth).toBeNull();
  });

  it('signs the user out on 401 and surfaces the error envelope', async () => {
    const onUnauthorized = vi.fn();
    setAuthTokenHooks({ getToken: () => Promise.resolve(undefined), onUnauthorized });
    server.use(http.get('/api/export/transactions', () => HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }, { status: 401 })));
    await expect(requestText('/export/transactions', { accept: 'text/csv' })).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED', message: 'Authentication required' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it.each([403, 500])('throws an ApiError for HTTP %i instead of returning the body as a file', async (status) => {
    const onUnauthorized = vi.fn();
    setAuthTokenHooks({ getToken: () => Promise.resolve('t'), onUnauthorized });
    server.use(http.get('/api/export/transactions', () => new HttpResponse('<html>denied</html>', { status, statusText: 'Nope' })));
    const err = await requestText('/export/transactions', { accept: 'text/csv' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, code: `HTTP_${status}`, message: 'Nope' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps network failures and rethrows aborts', async () => {
    server.use(http.get('/api/export/transactions', () => HttpResponse.error()));
    await expect(requestText('/export/transactions', { accept: 'text/csv' })).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    const controller = new AbortController();
    controller.abort();
    await expect(requestText('/export/transactions', { accept: 'text/csv', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('errorMessage', () => {
  it('extracts messages from ApiError, Error and unknown values', () => {
    expect(errorMessage(new ApiError(500, 'X', 'api says no'))).toBe('api says no');
    expect(errorMessage(new TypeError('type says no'))).toBe('type says no');
    expect(errorMessage('a string')).toBe('Something went wrong.');
    expect(errorMessage(undefined)).toBe('Something went wrong.');
  });
});


describe('free-plan budget guard errors', () => {
  const NOW = Date.parse('2026-10-19T10:00:00Z');
  const local = (ms: number) => new Intl.DateTimeFormat('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

  afterEach(() => {
    resetBudgetNotice();
    vi.useRealTimers();
  });

  it('turns 429 BUDGET_EXHAUSTED into a calm "resumes at" message from Retry-After', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    server.use(http.get('/api/holdings', () => budgetExhausted('3600')));
    const err = await api.getHoldings('all').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'BUDGET_EXHAUSTED', resumesAt: NOW + 3_600_000, details: { blockedMetrics: ['rowsRead'] } });
    expect(errorMessage(err)).toBe(`Paused to stay inside the free plan, resumes at ${local(NOW + 3_600_000)}.`);
  });

  it('falls back to a default wait when Retry-After is missing', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    server.use(http.get('/api/holdings', () => budgetExhausted(null)));
    await expect(api.getHoldings('all')).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED', resumesAt: NOW + 300_000 });
  });

  it('gives 503 BUDGET_UNAVAILABLE its own short message', async () => {
    server.use(http.delete('/api/transactions/t1', () => budgetUnavailable()));
    const err = await api.deleteTransaction('t1').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: 'BUDGET_UNAVAILABLE' });
    expect(errorMessage(err)).toBe('Usage could not be checked, so changes are paused for a moment. Try again shortly.');
  });

  it('recognises the guard in text downloads too', async () => {
    server.use(http.get('/api/export/transactions', () => budgetExhausted('60')));
    await expect(requestText('/export/transactions', { accept: 'text/csv' })).rejects.toMatchObject({ status: 429, code: 'BUDGET_EXHAUSTED' });
  });

  it('keeps other error codes untouched, also on a 429', async () => {
    server.use(http.get('/api/holdings', () => HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'Slow down' } }, { status: 429, headers: { 'Retry-After': '5' } })));
    const err = await api.getHoldings('all').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: 'RATE_LIMITED', message: 'Slow down' });
    expect((err as ApiError).resumesAt).toBeUndefined();
  });

  it('remembers a refusal for the page and a successful request ends it (JSON and text)', async () => {
    server.use(http.get('/api/holdings', () => budgetExhausted('60')));
    await api.getHoldings('all').catch(() => undefined);
    expect(getBudgetNotice()?.code).toBe('BUDGET_EXHAUSTED');
    server.resetHandlers();
    await api.getHoldings('all');
    expect(getBudgetNotice()).toBeUndefined();

    reportBudgetError('BUDGET_EXHAUSTED', Date.now() + 60_000);
    server.use(http.get('/api/export/transactions', () => new HttpResponse('a,b')));
    await requestText('/export/transactions', { accept: 'text/csv' });
    expect(getBudgetNotice()).toBeUndefined();
  });
});
