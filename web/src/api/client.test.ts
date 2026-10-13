import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ApiError, api, apiUrl, errorMessage, request, uploadCsv } from './client';

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

  it('falls back to the status text or a generic message for non-JSON error bodies', async () => {
    server.use(http.get('/api/holdings', () => new HttpResponse('<html>oops</html>', { status: 500, statusText: 'Internal Server Error' })));
    await expect(api.getHoldings()).rejects.toMatchObject({ status: 500, code: 'HTTP_500', message: 'Internal Server Error' });

    // MSW always fills in a status text, so stub fetch to simulate a proxy that sends none.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 418 }));
    await expect(api.getHoldings()).rejects.toMatchObject({ status: 418, code: 'HTTP_418', message: 'Request failed with status 418' });
  });

  it('ignores malformed error envelopes', async () => {
    server.use(http.get('/api/holdings', () => HttpResponse.json({ error: null }, { status: 400, statusText: 'Bad Request' })));
    await expect(api.getHoldings()).rejects.toMatchObject({ code: 'HTTP_400', message: 'Bad Request' });
    server.use(http.get('/api/holdings', () => HttpResponse.json({ error: { code: 'X', message: 42 } }, { status: 400, statusText: 'Bad Request' })));
    await expect(api.getHoldings()).rejects.toMatchObject({ code: 'HTTP_400' });
    server.use(http.get('/api/holdings', () => HttpResponse.json(['nope'], { status: 400, statusText: 'Bad Request' })));
    await expect(api.getHoldings()).rejects.toMatchObject({ code: 'HTTP_400' });
  });

  it('rejects invalid JSON in successful responses', async () => {
    server.use(http.get('/api/portfolio', () => new HttpResponse('not json', { status: 200 })));
    await expect(api.getPortfolio()).rejects.toMatchObject({ status: 200, code: 'INVALID_RESPONSE', message: 'The server returned an invalid response.' });
  });

  it('returns undefined for an empty 200 body', async () => {
    server.use(http.get('/api/portfolio', () => new HttpResponse(null, { status: 200 })));
    await expect(api.getPortfolio()).resolves.toBeUndefined();
  });

  it('re-throws aborts untouched', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await api.getPortfolio(controller.signal).catch((e: unknown) => e);
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
    await expect(api.createImport({ fileName: 'a.csv' })).resolves.toMatchObject({ importId: 'i1' });
    expect(seen).toEqual({ contentType: 'application/json', accept: 'application/json', body: { fileName: 'a.csv' } });

    const history = await api.getHistory('3M');
    expect(history.range).toBe('3M');
    const allocation = await api.getAllocation('currency');
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

  it('falls back to FileReader when Blob.text() is missing', async () => {
    let body = '';
    server.use(
      http.put(URL_, async ({ request: req }) => {
        body = await req.text();
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const blob = new Blob(['via FileReader']);
    Object.defineProperty(blob, 'text', { value: undefined });
    await uploadCsv(URL_, blob);
    expect(body).toBe('via FileReader');
  });

  it('maps unreadable files to FILE_READ_FAILED', async () => {
    const rejecting = { text: () => Promise.reject(new Error('io')) } as unknown as Blob;
    await expect(uploadCsv(URL_, rejecting)).rejects.toMatchObject({ code: 'FILE_READ_FAILED', message: 'The selected file could not be read.' });

    const blob = new Blob(['x']);
    Object.defineProperty(blob, 'text', { value: undefined });
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
    });
    await expect(uploadCsv(URL_, blob)).rejects.toMatchObject({ code: 'FILE_READ_FAILED' });
  });

  it('resolves an empty string when FileReader yields no result', async () => {
    let body: string | null = null;
    server.use(
      http.put(URL_, async ({ request: req }) => {
        body = await req.text();
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const blob = new Blob(['ignored']);
    Object.defineProperty(blob, 'text', { value: undefined });
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
    });
    await uploadCsv(URL_, blob);
    expect(body).toBe('');
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

describe('errorMessage', () => {
  it('extracts messages from ApiError, Error and unknown values', () => {
    expect(errorMessage(new ApiError(500, 'X', 'api says no'))).toBe('api says no');
    expect(errorMessage(new TypeError('type says no'))).toBe('type says no');
    expect(errorMessage('a string')).toBe('Something went wrong.');
    expect(errorMessage(undefined)).toBe('Something went wrong.');
  });
});

