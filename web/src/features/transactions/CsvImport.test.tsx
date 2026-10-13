import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { CsvImport } from './CsvImport';
import { buildSampleCsv, CSV_HEADER } from './sampleCsv';
import { renderWithProviders } from '../../test/utils';
import { server } from '../../mocks/server';
import { listTransactions, resetDb } from '../../mocks/db';

const csvFile = (content: string, name = 'trades.csv') => new File([content], name, { type: 'text/csv' });

describe('CsvImport', () => {
  it('shows the expected header', () => {
    renderWithProviders(<CsvImport />);
    expect(screen.getByTestId('csv-header')).toHaveTextContent(CSV_HEADER);
    expect(screen.getByRole('button', { name: 'Download sample CSV' })).toBeInTheDocument();
  });

  it('creates an import, uploads the file, polls until COMPLETED and invalidates queries', async () => {
    resetDb({ empty: true });
    const user = userEvent.setup();
    const calls: string[] = [];
    let uploadedContentType: string | null = null;
    server.events.on('request:start', ({ request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
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
});
