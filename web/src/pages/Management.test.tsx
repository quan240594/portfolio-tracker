import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp } from '../test/utils';
import { server } from '../mocks/server';
import { getPortfolio } from '../mocks/db';
import { formatMoney } from '../lib/format';
import { sp } from '../test/utils';
import * as form from '../features/management/form';
import { setAuthTokenHooks } from '../features/auth/tokenHooks';

function stubDownload() {
  return vi.spyOn(form, 'downloadFile').mockImplementation(() => undefined);
}

describe('TransactionsPage management actions', () => {
  afterEach(() => setAuthTokenHooks(undefined));

  it('shows splits and cash movements without unit price or fee', async () => {
    renderApp('/transactions?portfolio=trading-212');
    const split = (await screen.findByText('SPLIT')).closest('tr')!;
    expect(within(split).getByText('×2')).toBeInTheDocument();
    expect(within(split).getAllByText('—')).toHaveLength(3);
  });

  it('shows cash movements without unit price or fee', async () => {
    renderApp('/transactions?portfolio=default');
    const table = await screen.findByRole('table', { name: 'Transactions, newest first' });
    const deposit = within(table).getAllByText('DEPOSIT')[0]!.closest('tr')!;
    expect(within(deposit).getByText('CASH.EUR')).toBeInTheDocument();
    expect(within(deposit).getAllByText('—')).toHaveLength(2);
  });

  it('downloads the transactions as CSV for the selected scope', async () => {
    const user = userEvent.setup();
    const download = stubDownload();
    renderApp('/transactions?portfolio=default');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(download).toHaveBeenCalled());
    const [name, text, mime] = download.mock.calls[0]!;
    expect(name).toBe('transactions-default.csv');
    expect(mime).toBe('text/csv');
    expect(text).toMatch(/^date,type,symbol,quantity,price,fee,currency,note,fxRate\n/);
    expect(text).toContain('DEPOSIT,CASH.EUR,30000,1,0,EUR,Initial deposit');
  });

  it('exports every portfolio from the combined view and reports failures', async () => {
    const user = userEvent.setup();
    const download = stubDownload();
    renderApp('/transactions');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(download.mock.calls[0]![0]).toBe('transactions-all.csv'));

    server.use(http.get('/api/export/transactions', () => new HttpResponse('nope', { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal Server Error');

    server.use(http.get('/api/export/transactions', () => HttpResponse.error()));
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server'));
  });

  it('exports with the Cognito bearer token and saves the file', async () => {
    setAuthTokenHooks({ getToken: () => Promise.resolve('id-token-123'), onUnauthorized: vi.fn() });
    const auth: (string | null)[] = [];
    server.use(
      http.get('/api/export/transactions', ({ request }) => {
        auth.push(request.headers.get('authorization'));
        return new HttpResponse('date,type\n', { headers: { 'content-type': 'text/csv' } });
      }),
    );
    const user = userEvent.setup();
    const download = stubDownload();
    renderApp('/transactions?portfolio=default');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(download).toHaveBeenCalledWith('transactions-default.csv', 'date,type\n', 'text/csv'));
    expect(auth).toEqual(['Bearer id-token-123']);
  });

  it.each([401, 403, 500])('shows an error and saves no file when the export answers HTTP %i', async (status) => {
    const onUnauthorized = vi.fn();
    setAuthTokenHooks({ getToken: () => Promise.resolve('id-token-123'), onUnauthorized });
    server.use(http.get('/api/export/transactions', () => HttpResponse.json({ error: { code: 'DENIED', message: `Denied ${status}` } }, { status })));
    const user = userEvent.setup();
    const download = stubDownload();
    renderApp('/transactions?portfolio=default');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(`Denied ${status}`);
    expect(download).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it('still exports in demo mode, where there is no token', async () => {
    const auth: (string | null)[] = [];
    server.use(
      http.get('/api/export/transactions', ({ request }) => {
        auth.push(request.headers.get('authorization'));
        return new HttpResponse('date,type\n');
      }),
    );
    const user = userEvent.setup();
    const download = stubDownload();
    renderApp('/transactions?portfolio=default');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(auth).toEqual([null]);
  });

  it('only offers settings for a single portfolio', async () => {
    renderApp('/transactions');
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('changes cash tracking and the default withholding tax, which changes the totals', async () => {
    const user = userEvent.setup();
    const before = getPortfolio('default');
    expect(before.cashValue).toBeGreaterThan(0);
    renderApp('/transactions?portfolio=default');
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings · Main portfolio' });
    const track = await within(dialog).findByRole('checkbox', { name: /Track cash/ });
    expect(track).toBeChecked();
    expect(within(dialog).getByLabelText(/Default dividend withholding tax/)).toHaveValue('15');

    await user.click(track);
    await user.clear(within(dialog).getByLabelText(/Default dividend withholding tax/));
    await user.type(within(dialog).getByLabelText(/Default dividend withholding tax/), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('between 0 and 100');
    await user.clear(within(dialog).getByLabelText(/Default dividend withholding tax/));
    await user.click(within(dialog).getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(getPortfolio('default').cashValue).toBeUndefined();
    expect(getPortfolio('default').totalValue).toBeCloseTo(before.totalValue - (before.cashValue ?? 0), 1);
  });

  it('shows a settings error and the failure to save', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/portfolios/default/settings', () => HttpResponse.json({ error: { code: 'X', message: 'No settings' } }, { status: 500 }), { once: true }));
    renderApp('/transactions?portfolio=default&action=settings');
    expect(await screen.findByText('No settings')).toBeInTheDocument();
    await user.keyboard('{Escape}');

    server.use(http.put('/api/portfolios/default/settings', () => HttpResponse.json({ error: { code: 'X', message: 'Read-only' } }, { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Read-only')).toBeInTheDocument();
  });

  it('downloads the full backup and reports a failure', async () => {
    const user = userEvent.setup();
    const download = stubDownload();
    renderApp('/transactions?portfolio=default&action=settings');
    await user.click(await screen.findByRole('button', { name: 'Download backup (JSON)' }));
    await waitFor(() => expect(download).toHaveBeenCalled());
    const backup = JSON.parse(download.mock.calls[0]![1]);
    expect(download.mock.calls[0]![0]).toBe('portfolio-backup.json');
    expect(backup).toMatchObject({ version: 1, baseCurrency: 'EUR' });
    expect(backup.portfolios).toHaveLength(2);
    expect(backup.categories).toHaveLength(5);
    expect(backup.customAssets).toHaveLength(3);
    expect(backup.watchlist).toHaveLength(3);
    expect(JSON.stringify(backup)).not.toMatch(/secret|token|password/i);

    server.use(http.get('/api/export/backup', () => HttpResponse.json({ error: { code: 'X', message: 'Backup failed' } }, { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'Download backup (JSON)' }));
    expect(await screen.findByText('Backup failed')).toBeInTheDocument();
  });
});

describe('DashboardPage management widgets', () => {
  it('shows cash and custom assets in the KPIs and the watchlist card', async () => {
    renderApp('/?portfolio=default');
    const summary = getPortfolio('default');
    const cash = await screen.findByRole('region', { name: 'Cash' });
    expect(cash).toHaveTextContent(sp(formatMoney(summary.cashValue!, 'EUR')));
    expect(screen.getByRole('region', { name: 'Custom assets' })).toHaveTextContent(sp(formatMoney(summary.customAssetsValue!, 'EUR')));
    const watch = await screen.findByRole('region', { name: 'Watchlist' });
    expect(await within(watch).findByText('NVDA')).toBeInTheDocument();
    expect(within(watch).getByRole('link', { name: 'Manage →' })).toHaveAttribute('href', '/watchlist?portfolio=default');
  });

  it('offers allocation by category for a single portfolio only', async () => {
    const user = userEvent.setup();
    renderApp('/?portfolio=default');
    await user.click(await screen.findByRole('tab', { name: 'Category' }));
    expect(await screen.findByText('Core ETFs')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
  });

  it('hides the category tab in the combined view and falls back to another dimension', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/?portfolio=default');
    await user.click(await screen.findByRole('tab', { name: 'Category' }));
    await router.navigate('/?portfolio=all');
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Category' })).not.toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Asset class', selected: true })).toBeInTheDocument();
  });

  it('hides the watchlist card when it is empty and shows an error when it fails', async () => {
    server.use(http.get('/api/watchlist', () => HttpResponse.json({ items: [] })));
    renderApp('/');
    await screen.findByRole('region', { name: 'Top holdings' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Watchlist' })).not.toBeInTheDocument());
  });

  it('shows a watchlist error with retry', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/watchlist', () => HttpResponse.error(), { once: true }));
    renderApp('/');
    expect(await screen.findByText('Could not load watchlist')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('NVDA')).toBeInTheDocument();
  });
});

describe('Holdings with cash and custom assets', () => {
  it('shows cash and a readable label for custom assets', async () => {
    renderApp('/holdings?portfolio=default');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('rowheader', { name: /CASH\.EUR/ })).toBeInTheDocument();
    expect(within(table).getAllByRole('rowheader', { name: /Custom asset/ })).toHaveLength(3);
  });
});
