import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { report } from '../../test/diagnostics';
import { earningsDates, earningsRun, heldDate } from '../../test/earningsDates';
import { pricesStatus } from '../../test/priceCoverage';
import { renderWithProviders } from '../../test/utils';
import { DiagnosticsView } from './DiagnosticsView';

const refreshes: string[] = [];

function serve(body: ReturnType<typeof earningsDates> | number = earningsDates(), refresh: Response | (() => Response) = () => HttpResponse.json({ accepted: true }, { status: 202 })) {
  refreshes.length = 0;
  server.use(
    http.get(api('/diagnostics/alarms'), () => HttpResponse.json(report())),
    http.get(api('/prices/status'), () => HttpResponse.json(pricesStatus())),
    http.get(api('/diagnostics/earnings-dates'), () => (typeof body === 'number' ? new HttpResponse(null, { status: body }) : HttpResponse.json(body))),
    http.post(api('/diagnostics/earnings-dates/refresh'), () => {
      refreshes.push('asked');
      return typeof refresh === 'function' ? refresh() : refresh;
    }),
  );
}

async function card() {
  renderWithProviders(<DiagnosticsView />);
  return screen.findByRole('region', { name: 'Earnings dates' });
}

describe('Earnings dates card', () => {
  it('shows the last run with its outcome, the rows the provider returned and how many matched', async () => {
    serve();
    const section = await card();
    expect(section).toHaveAttribute('id', 'earnings-dates');
    expect(within(section).getByText(/Last run:/).closest('p')).toHaveTextContent('Last run: 28-10-2026');
    expect(within(section).getByText(/Last run:/).closest('p')).toHaveTextContent('daily run');
    expect(within(section).getByText(/Last run:/).closest('p')).toHaveTextContent('Read the provider’s calendar');
    expect(within(section).getByText(/The provider returned 5120 rows, 3 of your 3 held companies matched; 3 dates stored\./)).toBeInTheDocument();
    expect(within(section).getByText(/Alpha Vantage today \(UTC\): 4 of 25 calls used; the daily refresh may use 1 \(1 used\)\./)).toBeInTheDocument();
    expect(within(section).getByText('2 of 3 held companies have an upcoming date.')).toBeInTheDocument();
  });

  it('lists the symbols without a date first, with the reason, and the others with their date and source', async () => {
    serve();
    const section = await card();
    const table = within(section).getByRole('table', { name: 'Next earnings date per held symbol, the ones without a date first' });
    const rows = within(table).getAllByRole('row').filter((row) => within(row).queryByRole('rowheader') !== null);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([expect.stringContaining('NOVO-B.CO'), expect.stringContaining('GOOGL'), expect.stringContaining('ASML.AS')]);
    const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells(rows[0]!)).toEqual(['No date', expect.stringContaining("Not in the provider's calendar")]);
    expect(cells(rows[1]!)).toEqual(['28-10-2026Scheduled, after the close', '–']);
    expect(cells(rows[2]!)).toEqual(['28-01-2027Projected', '–']);
  });

  it('does not count funds and crypto as companies and says they have no earnings', async () => {
    const base = earningsDates();
    const fund = { symbol: 'VWRL.AS', name: 'Vanguard FTSE All-World', next: null, reasonCode: 'not-applicable' as const, reason: 'Fund or crypto: no earnings' };
    serve(earningsDates({ funds: 2, symbols: [...base.symbols, heldDate(fund), heldDate({ ...fund, symbol: 'BTC-EUR', name: 'Bitcoin' })] }));
    const section = await card();
    expect(within(section).getByText('2 of 3 held companies have an upcoming date. 2 fund or crypto positions have no earnings and are not counted.')).toBeInTheDocument();
    const rows = within(section).getAllByRole('row').filter((row) => within(row).queryByRole('rowheader') !== null);
    const cells = within(rows[3]!).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells).toEqual(['No earnings', 'Fund or crypto: no earnings']);
    expect(section).not.toHaveTextContent('not in the provider');
    expect(section).not.toHaveTextContent('has not run yet');
  });

  it('says there is no company to check when only funds are held, and counts a single fund', async () => {
    const fund = heldDate({ symbol: 'VWRL.AS', name: 'Vanguard FTSE All-World', next: null, reasonCode: 'not-applicable', reason: 'Fund or crypto: no earnings' });
    serve(earningsDates({ held: 0, withDate: 0, funds: 1, symbols: [fund] }));
    const section = await card();
    expect(within(section).getByText('No held company to check. 1 fund or crypto position has no earnings and is not counted.')).toBeInTheDocument();
  });

  it('explains a run that failed, keeps the last good one visible and shows the first run as pending', async () => {
    serve(earningsDates({ lastRun: earningsRun({ at: '2026-10-28T04:30:00.000Z', status: 'failed', reason: 'alphavantage: unexpected response for EARNINGS_CALENDAR', rows: null, events: null, matchedHeld: null }), lastSuccess: earningsRun({ at: '2026-10-27T04:30:00.000Z' }) }));
    const section = await card();
    expect(within(section).getByText('Provider call failed', { exact: false })).toBeInTheDocument();
    expect(within(section).getByText('Reason: alphavantage: unexpected response for EARNINGS_CALENDAR')).toBeInTheDocument();
    expect(within(section).getByText(/Last successful run:/).closest('p')).toHaveTextContent('27-10-2026');
  });

  it('says so when no run has happened, or none has read the calendar, and shows rows that were not recorded', async () => {
    serve(earningsDates({ lastRun: null, lastSuccess: null, budget: null, held: 0, withDate: 0, funds: 0, symbols: [] }));
    const { unmount } = renderWithProviders(<DiagnosticsView />);
    expect(await screen.findByText('The calendar job has not run yet. It runs daily at 05:30 Amsterdam time.')).toBeInTheDocument();
    expect(screen.getByText('No open positions to check.')).toBeInTheDocument();
    unmount();

    serve(earningsDates({ lastRun: earningsRun({ status: 'rate-limited', reason: 'alphavantage: rate limited', rows: null, events: null, matchedHeld: null }), lastSuccess: null }));
    renderWithProviders(<DiagnosticsView />);
    expect(await screen.findByText('No run has read the provider’s calendar yet.')).toBeInTheDocument();
  });

  it('counts a single symbol and a source that did not count its rows', async () => {
    serve(earningsDates({ held: 1, withDate: 1, symbols: [earningsDates().symbols[1]!], lastRun: earningsRun({ rows: null, events: 1, matchedHeld: null }), lastSuccess: null }));
    const section = await card();
    expect(within(section).getByText('1 of 1 held company has an upcoming date.')).toBeInTheDocument();
    expect(within(section).getByText(/Rows returned: not recorded; 1 date stored\./)).toBeInTheDocument();
  });

  it('queues the calendar job once and says so', async () => {
    serve();
    const user = userEvent.setup();
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Refresh earnings dates now' }));
    expect(await within(section).findByText(/Queued\. The job runs within a minute/)).toBeInTheDocument();
    expect(refreshes).toEqual(['asked']);
  });

  it('disables the button and says why when the refresh is not available', async () => {
    serve(earningsDates({ refresh: { available: false, reason: 'Alpha Vantage allowance nearly used: 24 of 25 calls today (UTC).', nextAllowedAt: '2026-10-29T00:00:00.000Z' } }));
    const section = await card();
    expect(within(section).getByRole('button', { name: 'Refresh earnings dates now' })).toBeDisabled();
    expect(within(section).getByText('Alpha Vantage allowance nearly used: 24 of 25 calls today (UTC).')).toBeInTheDocument();
  });

  it('shows the reason when the server refuses the refresh', async () => {
    serve(earningsDates(), () => HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'You can ask again after 10:30 UTC.' } }, { status: 429 }));
    const user = userEvent.setup();
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Refresh earnings dates now' }));
    expect(await within(section).findByText('You can ask again after 10:30 UTC.')).toBeInTheDocument();
  });

  it('says so when the refresh could not be queued at all', async () => {
    serve(earningsDates(), () => new HttpResponse(null, { status: 500 }));
    const user = userEvent.setup();
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Refresh earnings dates now' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('The refresh could not be queued. Try again later.');
  });

  it('shows nothing where the backend has no such report, and a retry where it could not be read', async () => {
    serve(404);
    renderWithProviders(<DiagnosticsView />);
    expect(await screen.findByRole('region', { name: 'Chart reconciliation' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Earnings dates' })).not.toBeInTheDocument();
  });

  it('offers a retry when the report could not be read', async () => {
    serve(500);
    const user = userEvent.setup();
    renderWithProviders(<DiagnosticsView />);
    const failed = await screen.findByRole('region', { name: 'Earnings dates' });
    expect(within(failed).getByText('The earnings dates could not be read.')).toBeInTheDocument();
    serve();
    await user.click(within(failed).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('2 of 3 held companies have an upcoming date.')).toBeInTheDocument());
  });
});
