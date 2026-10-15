import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { BrokerStatusResponse } from '@portfolio/shared';
import { renderApp, renderWithProviders } from '../../test/utils';
import { server } from '../../mocks/server';
import { resetBrokerMock } from '../../mocks/broker';
import { createPortfolio } from '../../mocks/db';
import { StatusCard } from './StatusCard';
import { suggestedPortfolio } from './ConnectForm';

const KEY = 'live-key-123';
const SECRET = 'live-secret-456';

beforeEach(() => resetBrokerMock());

async function fill(user: ReturnType<typeof userEvent.setup>, key = KEY, secret = SECRET) {
  await user.type(await screen.findByLabelText('API key'), key);
  await user.type(screen.getByLabelText('API secret'), secret);
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
  await fill(user);
  await user.click(screen.getByRole('button', { name: 'Test & connect' }));
}

describe('Trading 212 page', () => {
  it('is reachable from the navigation and titled', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Brokers' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Trading 212' })).toBeInTheDocument();
    expect(document.title).toBe('Trading 212 · Portfolio Tracker');
  });

  it('shows the connect form with masked fields and the read-only key instructions', async () => {
    renderApp('/brokers');
    expect(screen.getByText('Loading Trading 212 status')).toBeInTheDocument();
    const key = await screen.findByLabelText('API key');
    expect(key).toHaveAttribute('type', 'password');
    expect(key).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByLabelText('API secret')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Environment')).toHaveValue('live');
    expect(screen.getByRole('button', { name: 'Test & connect' })).toBeDisabled();

    const how = screen.getByRole('region', { name: 'How to connect' });
    expect(how).toHaveTextContent('Settings → API (Beta)');
    for (const scope of ['account', 'metadata', 'portfolio', 'history:orders', 'history:dividends', 'history:transactions']) {
      expect(within(how).getByText(scope)).toBeInTheDocument();
    }
    expect(how).toHaveTextContent('Do not enable order execution or pies');
    expect(how).toHaveTextContent('Leave it unrestricted');
  });

  it('preselects the portfolio named after Trading 212 and lists all portfolios', async () => {
    renderApp('/brokers');
    const select = await screen.findByLabelText('Import into portfolio');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Main portfolio', 'Trading 212']);
    expect((select as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Trading 212');
  });

  it('connects, runs the first sync and shows the status card without keeping the secret anywhere', async () => {
    const user = userEvent.setup();
    renderApp('/brokers');
    await connect(user);

    const card = await screen.findByRole('region', { name: 'Trading 212 status' });
    expect(await within(card).findByText('Up to date')).toBeInTheDocument();
    expect(within(card).getByTestId('last-sync')).toHaveTextContent(/^Last sync: /);
    expect(within(card).getByLabelText('Last sync')).toHaveTextContent('42');
    expect(within(card).getByRole('table', { name: 'Instruments that were not imported' })).toHaveTextContent('EXAMPLE_EQ');
    expect(within(card).getByRole('table')).toHaveTextContent('Exchange could not be determined');
    expect(card).toHaveTextContent('account currency EUR');

    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const store of [localStorage, sessionStorage]) {
      expect(JSON.stringify({ ...store })).not.toMatch(new RegExp(`${KEY}|${SECRET}`));
    }
  });

  it('keeps the secret out of the form after submitting and out of the url', async () => {
    const user = userEvent.setup();
    let body = '';
    server.events.on('request:start', async ({ request }) => {
      if (request.method === 'PUT') body = await request.clone().text();
    });
    renderApp('/brokers');
    await connect(user);
    await screen.findByRole('region', { name: 'Trading 212 status' });
    await waitFor(() => expect(JSON.parse(body)).toMatchObject({ apiKey: KEY, apiSecret: SECRET, environment: 'live', portfolioId: 'trading-212' }));
    expect(window.location.href).not.toContain(SECRET);
    server.events.removeAllListeners();
  });

  it('shows the Trading 212 rejection and stays on the form', async () => {
    const user = userEvent.setup();
    renderApp('/brokers');
    await fill(user, 'invalid', 'whatever');
    await user.click(screen.getByRole('button', { name: 'Test & connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Trading 212 rejected the credentials');
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(screen.queryByRole('region', { name: 'Trading 212 status' })).toBeNull();
  });

  it('sends the chosen environment and portfolio', async () => {
    const user = userEvent.setup();
    createPortfolio('Second');
    let sent: unknown;
    server.use(
      http.put('/api/brokers/trading212', async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp('/brokers');
    await user.selectOptions(await screen.findByLabelText('Import into portfolio'), 'Second');
    await user.selectOptions(screen.getByLabelText('Environment'), 'demo');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Test & connect' }));
    await waitFor(() => expect(sent).toMatchObject({ environment: 'demo', portfolioId: expect.not.stringMatching(/^default$/) }));
  });

  it('syncs on demand and then disconnects after a confirmation', async () => {
    const user = userEvent.setup();
    renderApp('/brokers');
    await connect(user);
    const card = await screen.findByRole('region', { name: 'Trading 212 status' });
    await within(card).findByText('Up to date');

    await user.click(within(card).getByRole('button', { name: 'Sync now' }));
    expect(await within(card).findByText('Syncing…', { selector: '[data-testid="sync-status"]' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Syncing…' })).toBeDisabled();
    await within(card).findByText('Up to date');

    await user.click(within(card).getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Disconnect Trading 212?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await user.click(within(card).getByRole('button', { name: 'Disconnect' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByLabelText('API key')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Trading 212 status' })).toBeNull();
  });

  it('refreshes the imported data once a sync has finished', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderApp('/brokers');
    await connect(user);
    const card = await screen.findByRole('region', { name: 'Trading 212 status' });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await within(card).findByText('Up to date');
    await waitFor(() => expect(spy.mock.calls.some((c) => (c[0] as { queryKey: string[] }).queryKey[0] === 'holdings')).toBe(true));
  });

  it('reports that Trading 212 is connected to another portfolio', async () => {
    const user = userEvent.setup();
    createPortfolio('Other');
    server.use(
      http.put('/api/brokers/trading212', () =>
        HttpResponse.json({ error: { code: 'BROKER_ALREADY_CONNECTED', message: 'Trading 212 is already connected to another portfolio; disconnect it first' } }, { status: 409 }),
      ),
    );
    renderApp('/brokers');
    await connect(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('already connected to another portfolio');
  });

  it('offers a retry when the status cannot be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(
      http.get('/api/brokers/trading212', () => (fail ? HttpResponse.json({ error: { code: 'BROKER_UNAVAILABLE', message: 'The Trading 212 sync is not configured' } }, { status: 503 }) : HttpResponse.json({ broker: 'trading212', portfolioId: 'default', connected: false }))),
    );
    renderApp('/brokers');
    expect(await screen.findByRole('alert')).toHaveTextContent('The Trading 212 sync is not configured');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('API key')).toBeInTheDocument();
  });

  it('retries the portfolio list when that is what failed', async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(http.get('/api/portfolios', () => (fail ? HttpResponse.json({ error: { code: 'X', message: 'portfolios down' } }, { status: 500 }) : HttpResponse.json({ portfolios: [{ portfolioId: 'default', userId: 'demo', name: 'Main', createdAt: 'x', updatedAt: 'x' }] }))));
    renderApp('/brokers');
    expect(await screen.findByRole('alert')).toHaveTextContent('portfolios down');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('API key')).toBeInTheDocument();
  });
});

describe('StatusCard', () => {
  const portfolios = [{ portfolioId: 'p1', userId: 'u', name: 'Broker', createdAt: 'x', updatedAt: 'x' }];
  const base: BrokerStatusResponse = { broker: 'trading212', portfolioId: 'p1', connected: true, environment: 'live', status: 'CONNECTED' };

  it('explains a fresh connection', () => {
    renderWithProviders(<StatusCard status={base} portfolios={portfolios} />);
    expect(screen.getByText('Connected, not synced yet')).toBeInTheDocument();
    expect(screen.getByTestId('last-sync')).toHaveTextContent('Not synced yet.');
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled();
    expect(screen.queryByLabelText('Last sync')).toBeNull();
  });

  it('shows failures, warnings, skipped records and the demo environment', () => {
    renderWithProviders(
      <StatusCard
        status={{
          ...base,
          environment: 'demo',
          status: 'FAILED',
          lastSyncAt: '2026-03-02T10:00:00.000Z',
          lastSuccessAt: '2026-03-01T10:00:00.000Z',
          lastError: 'T212_AUTH_REJECTED: Trading 212 rejected the credentials.',
          warnings: ['Cash history unavailable'],
          counts: { orders: 1, dividends: 2, written: 3, skipped: 4, cashMovements: { deposits: 5, withdrawals: 6, fees: 0, interest: 7, other: 0 } },
          unmapped: [
            { ticker: 'A_EQ', reason: 'NO_PATTERN', count: 1, name: 'Alpha' },
            { ticker: 'B_EQ', reason: 'UNSUPPORTED_FILL_EQUITY_RIGHTS', count: 2 },
            { ticker: 'C_EQ', reason: 'SOMETHING_NEW', count: 3 },
          ],
        }}
        portfolios={portfolios}
      />,
    );
    expect(screen.getByRole('heading', { name: /Trading 212 \(demo\)/ })).toBeInTheDocument();
    expect(screen.getByText('Last sync failed')).toBeInTheDocument();
    expect(screen.getByTestId('last-sync')).toHaveTextContent(/last success/);
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('T212_AUTH_REJECTED: Trading 212 rejected the credentials.');
    expect(screen.getByText('Cash history unavailable')).toBeInTheDocument();
    expect(screen.getByText(/5 deposits, 6 withdrawals, 7 interest payments/)).toBeInTheDocument();
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('A_EQ · AlphaUnknown ticker format1');
    expect(rows[1]).toHaveTextContent('Corporate action not imported (equity rights)');
    expect(rows[2]).toHaveTextContent('SOMETHING_NEW');
  });

  it('shows a successful sync that is also the last one without repeating the time', () => {
    renderWithProviders(<StatusCard status={{ ...base, status: 'SUCCEEDED', lastSyncAt: '2026-03-02T10:00:00.000Z', lastSuccessAt: '2026-03-02T10:00:00.000Z' }} portfolios={portfolios} />);
    expect(screen.getByTestId('last-sync')).not.toHaveTextContent('last success');
  });

  it('shows errors of the sync and disconnect requests', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/brokers/trading212/sync', () => HttpResponse.json({ error: { code: 'NOT_CONNECTED', message: 'sync refused' } }, { status: 404 })),
      http.delete('/api/brokers/trading212', () => HttpResponse.json({ error: { code: 'X', message: 'disconnect refused' } }, { status: 500 })),
    );
    renderWithProviders(<StatusCard status={base} portfolios={portfolios} />);
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('sync refused')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('disconnect refused')).toBeInTheDocument();
  });
});

describe('suggestedPortfolio', () => {
  const p = (portfolioId: string, name: string) => ({ portfolioId, userId: 'u', name, createdAt: 'x', updatedAt: 'x' });
  it('prefers a portfolio named after Trading 212, else the first, else nothing', () => {
    expect(suggestedPortfolio([p('a', 'Main'), p('b', 'trading212 ISA')])).toBe('b');
    expect(suggestedPortfolio([p('a', 'Main'), p('b', 'Other')])).toBe('a');
    expect(suggestedPortfolio([])).toBe('');
  });
});
