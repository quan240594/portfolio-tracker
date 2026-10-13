import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { CsvImport } from './CsvImport';
import { buildSampleCsv, CSV_HEADER } from './sampleCsv';
import { renderWithProviders } from '../../test/utils';
import { server } from '../../mocks/server';
import { listTransactions, resetDb } from '../../mocks/db';
import { renderHook, act } from '@testing-library/react';
import { useCsvImport } from './useCsvImport';
import { createTestQueryClient } from '../../test/utils';
import { QueryClientProvider } from '@tanstack/react-query';

/** The portfolio picker loads GET /portfolios; the import pipeline assertions ignore it. */
const isPortfolioList = (request: Request) => new URL(request.url).pathname === '/api/portfolios';

const csvFile = (content: string, name = 'trades.csv') => new File([content], name, { type: 'text/csv' });

describe('CsvImport', () => {
  it('shows the expected header', () => {
    renderWithProviders(<CsvImport />);
    expect(screen.getByTestId('csv-header')).toHaveTextContent(CSV_HEADER);
    expect(CSV_HEADER).toMatch(/,note,fxRate$/);
    expect(screen.getByText(/numbers use a dot as decimal separator/)).toHaveTextContent('note and fxRate are optional');
    expect(screen.getByTestId('csv-fxrate-help')).toHaveTextContent(
      'fxRate: units of the trade currency per 1 EUR, as on your broker statement (e.g. 1.0842 for USD). Leave it empty for EUR trades, or to use the ECB rate of the trade date.',
    );
    expect(screen.getByRole('button', { name: 'Download sample CSV' })).toBeInTheDocument();
  });

  it('creates an import, uploads the file, polls until COMPLETED and invalidates queries', async () => {
    resetDb({ empty: true });
    const user = userEvent.setup();
    const calls: string[] = [];
    let uploadedContentType: string | null = null;
    server.events.on('request:start', ({ request }) => {
      if (!isPortfolioList(request)) calls.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === 'PUT') uploadedContentType = request.headers.get('content-type');
    });

    const { queryClient } = renderWithProviders(<CsvImport pollIntervalMs={5} />);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await user.upload(screen.getByLabelText('CSV file'), csvFile(buildSampleCsv()));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));

    expect(await screen.findByText('✓ Import completed')).toBeInTheDocument();
    expect(screen.getByText(/Imported 5 of 5 rows from trades\.csv/)).toBeInTheDocument();

    expect(calls[0]).toBe('POST /api/imports');
    expect(calls[1]).toMatch(/^PUT \/__mock-s3\/imports\//);
    expect(calls.filter((c) => c.startsWith('GET /api/imports/')).length).toBeGreaterThanOrEqual(2);
    expect(uploadedContentType).toBe('text/csv');
    expect(listTransactions()).toHaveLength(5);
    // The optional fxRate column is imported (header matched case-insensitively), empty cells are omitted.
    const imported = listTransactions();
    expect(imported.filter((t) => t.fxRate !== undefined)).toEqual([expect.objectContaining({ symbol: 'AAPL', type: 'BUY', fxRate: 1.0812 })]);

    const invalidated = invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
    expect(invalidated).toEqual(expect.arrayContaining(['portfolio', 'holdings', 'allocation', 'history', 'dividends', 'transactions']));
    server.events.removeAllListeners();
  });

  it('shows row-level errors when the import FAILED', async () => {
    const user = userEvent.setup();
    const before = listTransactions().length;
    renderWithProviders(<CsvImport pollIntervalMs={5} />);

    const bad = [CSV_HEADER, '2024-01-15,BUY,VWRL.AS,10,100,0,EUR,', '2024-13-01,HOLD,AAPL,-1,10,0,USD,'].join('\n');
    await user.upload(screen.getByLabelText('CSV file'), csvFile(bad));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Import failed — nothing was imported');
    const table = within(alert).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(/^3/);
    expect(rows[0]).toHaveTextContent(/type/);
    expect(rows[0]).toHaveTextContent(/quantity/);
    expect(listTransactions()).toHaveLength(before);

    await user.click(screen.getByRole('button', { name: 'Import another file' }));
    expect(screen.getByLabelText('CSV file')).toBeInTheDocument();
  });

  it('reports a FAILED status returned by the API with its errors', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/imports/:id', ({ params }) =>
        HttpResponse.json({
          importId: String(params.id), userId: 'demo', fileName: 'trades.csv', status: 'FAILED', rowCount: 2, importedCount: 0,
          errors: [{ row: 2, message: 'Cannot sell 5 KO on 2024-01-01: only 0 held' }],
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:01Z',
        }),
      ),
    );
    renderWithProviders(<CsvImport pollIntervalMs={5} />);
    await user.upload(screen.getByLabelText('CSV file'), csvFile(`${CSV_HEADER}\n2024-01-01,SELL,KO,5,60,0,USD,`));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    expect(await screen.findByText(/Cannot sell 5 KO/)).toBeInTheDocument();
  });

  it('rejects non-CSV files before calling the API', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithProviders(<CsvImport pollIntervalMs={5} />);
    await user.upload(screen.getByLabelText('CSV file'), new File(['x'], 'trades.xlsx'));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only .csv files are supported');
  });

  it('gives up after the timeout', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/imports/:id', ({ params }) =>
        HttpResponse.json({
          importId: String(params.id), userId: 'demo', fileName: 'trades.csv', status: 'PROCESSING',
          createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:01Z',
        }),
      ),
    );
    renderWithProviders(<CsvImport pollIntervalMs={5} timeoutMs={30} />);
    await user.upload(screen.getByLabelText('CSV file'), csvFile(buildSampleCsv()));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/taking longer than expected/));
  });

  it('downloads the sample CSV', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:sample');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderWithProviders(<CsvImport />);
      await user.click(screen.getByRole('button', { name: 'Download sample CSV' }));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      // @ts-expect-error remove stubs jsdom does not provide
      delete URL.createObjectURL;
      // @ts-expect-error remove stubs jsdom does not provide
      delete URL.revokeObjectURL;
    }
  });

  it('disables the submit button until a file is chosen, and again when the selection is cleared', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CsvImport />);
    const submit = screen.getByRole('button', { name: 'Upload & import' });
    expect(submit).toBeDisabled();
    const input = screen.getByLabelText('CSV file');
    await user.upload(input, csvFile('x'));
    expect(submit).toBeEnabled();
    fireEvent.change(input, { target: { files: [] } });
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    expect(screen.queryByRole('status')).toBeEmptyDOMElement();
  });

  it('shows upload and processing progress while busy, then offers Done', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((r) => (releaseUpload = r));
    server.use(
      http.put('*/__mock-s3/imports/:importId', async () => {
        await uploadGate;
        return new HttpResponse(null, { status: 200 });
      }),
      http.get('/api/imports/:id', ({ params }) =>
        HttpResponse.json({ importId: String(params.id), userId: 'demo', fileName: 'trades.csv', status: 'COMPLETED', createdAt: '', updatedAt: '' }),
      ),
    );
    renderWithProviders(<CsvImport pollIntervalMs={20} onDone={onDone} />);
    await user.upload(screen.getByLabelText('CSV file'), csvFile(buildSampleCsv()));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));

    expect(await screen.findByText('Uploading trades.csv…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled();
    expect(screen.getByLabelText('CSV file')).toBeDisabled();

    releaseUpload();
    expect(await screen.findByText(/Processing trades\.csv… this usually takes a few seconds\./)).toBeInTheDocument();
    expect(await screen.findByText('✓ Import completed')).toBeInTheDocument();
    // Missing counts default to 0.
    expect(await screen.findByText('Imported 0 of 0 rows from trades.csv into Main portfolio.')).toBeInTheDocument();
    expect(screen.queryByLabelText('CSV file')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Import another file' }));
    expect(screen.getByLabelText('CSV file')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Upload & import' })).toBeDisabled();
  });

  it('has no Done button without an onDone handler', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CsvImport pollIntervalMs={5} />);
    await user.upload(screen.getByLabelText('CSV file'), csvFile(buildSampleCsv()));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    expect(await screen.findByText('✓ Import completed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  });

  it('reports a failed upload to storage', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    server.events.on('request:start', ({ request }) => {
        if (!isPortfolioList(request)) calls.push(`${request.method} ${new URL(request.url).pathname}`);
      });
    server.use(http.put('*/__mock-s3/imports/:importId', () => new HttpResponse('denied', { status: 500 })));
    renderWithProviders(<CsvImport pollIntervalMs={5} />);
    await user.upload(screen.getByLabelText('CSV file'), csvFile(buildSampleCsv()));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Uploading the file failed (HTTP 500).');
    expect(calls.some((c) => c.startsWith('GET /api/imports/'))).toBe(false);
    server.events.removeAllListeners();

    await user.click(screen.getByRole('button', { name: 'Import another file' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports API errors when creating the import', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/imports', () => HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'Too many imports, slow down' } }, { status: 429 })));
    renderWithProviders(<CsvImport pollIntervalMs={5} />);
    await user.upload(screen.getByLabelText('CSV file'), csvFile('x'));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many imports, slow down');
  });

  it('surfaces unexpected (non-API) failures instead of hanging', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/imports', () => new HttpResponse(null, { status: 204 })));
    renderWithProviders(<CsvImport pollIntervalMs={5} />);
    await user.upload(screen.getByLabelText('CSV file'), csvFile('x'));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/importId/);
    expect(screen.getByRole('button', { name: 'Import another file' })).toBeInTheDocument();
  });

  it('rejects files larger than 1 MB before calling the API', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (!isPortfolioList(request)) calls.push(request.url);
    });
    renderWithProviders(<CsvImport />);
    await user.upload(screen.getByLabelText('CSV file'), csvFile('a'.repeat(1024 * 1024 + 1), 'big.csv'));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The file is larger than 1 MB.');
    expect(calls).toEqual([]);
    server.events.removeAllListeners();
  });

  it('shows a FAILED import without row details', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/imports/:id', ({ params }) =>
        HttpResponse.json({ importId: String(params.id), userId: 'demo', fileName: 'trades.csv', status: 'FAILED', errors: [], createdAt: '', updatedAt: '' }),
      ),
    );
    renderWithProviders(<CsvImport pollIntervalMs={5} />);
    await user.upload(screen.getByLabelText('CSV file'), csvFile('x'));
    await user.click(screen.getByRole('button', { name: 'Upload & import' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Import failed — nothing was imported');
    expect(within(alert).queryByRole('table')).not.toBeInTheDocument();
  });

  describe('stops the pipeline when closed mid-flight', () => {
    const track = () => {
      const calls: string[] = [];
      server.events.on('request:start', ({ request }) => {
        if (!isPortfolioList(request)) calls.push(`${request.method} ${new URL(request.url).pathname}`);
      });
      return calls;
    };
    const gated = () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      return { gate, release };
    };
    const settle = () => new Promise((r) => setTimeout(r, 60));
    afterEach(() => server.events.removeAllListeners());

    async function startImport(pollIntervalMs = 10) {
      const user = userEvent.setup();
      const view = renderWithProviders(<CsvImport pollIntervalMs={pollIntervalMs} />);
      await user.upload(screen.getByLabelText('CSV file'), csvFile(buildSampleCsv()));
      await user.click(screen.getByRole('button', { name: 'Upload & import' }));
      return view;
    }

    it('while creating the import', async () => {
      const calls = track();
      const { gate, release } = gated();
      server.use(
        http.post('/api/imports', async () => {
          await gate;
          return HttpResponse.json({ importId: 'imp-x', uploadUrl: `${location.origin}/__mock-s3/imports/imp-x`, expiresInSeconds: 60 }, { status: 201 });
        }),
      );
      const { unmount } = await startImport();
      unmount();
      release();
      await settle();
      expect(calls).toEqual(['POST /api/imports']);
    });

    it('while uploading', async () => {
      const calls = track();
      const { gate, release } = gated();
      server.use(
        http.put('*/__mock-s3/imports/:importId', async () => {
          await gate;
          return new HttpResponse(null, { status: 200 });
        }),
      );
      const { unmount } = await startImport();
      await waitFor(() => expect(calls.some((c) => c.startsWith('PUT'))).toBe(true));
      unmount();
      release();
      await settle();
      expect(calls.filter((c) => c.startsWith('GET'))).toEqual([]);
    });

    it('while waiting between polls', async () => {
      const calls = track();
      const { unmount } = await startImport(150);
      await screen.findByText(/^Processing/);
      unmount();
      await new Promise((r) => setTimeout(r, 250));
      expect(calls.filter((c) => c.startsWith('GET'))).toEqual([]);
    });

    it('while a status request is in flight', async () => {
      const calls = track();
      const { gate, release } = gated();
      server.use(
        http.get('/api/imports/:id', async ({ params }) => {
          await gate;
          return HttpResponse.json({ importId: String(params.id), userId: 'demo', fileName: 'trades.csv', status: 'PROCESSING', createdAt: '', updatedAt: '' });
        }),
      );
      const { unmount } = await startImport();
      await waitFor(() => expect(calls.some((c) => c.startsWith('GET'))).toBe(true));
      unmount();
      release();
      await settle();
      expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(1);
    });

    it('when a request fails after closing', async () => {
      const { gate, release } = gated();
      server.use(
        http.post('/api/imports', async () => {
          await gate;
          return HttpResponse.json({ error: { code: 'INTERNAL', message: 'late failure' } }, { status: 500 });
        }),
      );
      const errors = vi.spyOn(console, 'error');
      const { unmount } = await startImport();
      unmount();
      release();
      await settle();
      expect(errors).not.toHaveBeenCalled();
    });
  });

  describe('target portfolio', () => {
    it('defaults to the main portfolio, imports into the chosen one and reports it', async () => {
      resetDb({ empty: true });
      const user = userEvent.setup();
      let body: unknown;
      server.events.on('request:start', async ({ request }) => {
        if (request.method === 'POST' && new URL(request.url).pathname === '/api/imports') body = await request.clone().json();
      });
      renderWithProviders(<CsvImport pollIntervalMs={5} />);
      const select = screen.getByLabelText('Import into portfolio');
      expect(select).toBeRequired();
      await screen.findByRole('option', { name: 'Trading 212' });
      expect(select).toHaveValue('default');

      await user.selectOptions(select, 'Trading 212');
      await user.upload(screen.getByLabelText('CSV file'), csvFile(buildSampleCsv()));
      await user.click(screen.getByRole('button', { name: 'Upload & import' }));
      expect(await screen.findByText('Imported 5 of 5 rows from trades.csv into Trading 212.')).toBeInTheDocument();
      expect(body).toEqual({ fileName: 'trades.csv', portfolioId: 'trading-212' });
      expect(listTransactions('trading-212')).toHaveLength(5);
      expect(listTransactions('default')).toHaveLength(0);
      server.events.removeAllListeners();
    });

    it('preselects the portfolio in scope', async () => {
      renderWithProviders(<CsvImport />, { route: '/transactions?portfolio=trading-212' });
      expect(screen.getByLabelText('Import into portfolio')).toHaveValue('trading-212');
      expect(screen.getByRole('option', { name: 'Loading portfolios…' })).toBeInTheDocument();
      await screen.findByRole('option', { name: 'Trading 212' });
      expect(screen.getByLabelText('Import into portfolio')).toHaveValue('trading-212');
    });

    it('rejects an invalid portfolio id before calling the API', async () => {
      const qc = createTestQueryClient();
      const { result } = renderHook(() => useCsvImport(), {
        wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
      });
      await act(() => result.current.start(csvFile('a'), 'Not Valid'));
      expect(result.current.state).toEqual({ phase: 'error', message: 'Choose a portfolio to import into.' });
    });
  });
});
