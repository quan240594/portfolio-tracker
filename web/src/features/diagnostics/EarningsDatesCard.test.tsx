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
    expect(cells(rows[1]!)).toEqual(['28-10-2026Scheduled (provider date) · after the close', '–']);
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

  it('puts the verdict on the date sources at the top: what is missing, in words and not only in colour', async () => {
    const text = 'No provider date source is working. Alpha Vantage returned only 1 rows: its free plan does not provide the earnings calendar for this key. Finnhub is not configured: add a free key (the FINNHUB_API_KEY secret). Until then every date in the calendar is a projection (previous report + about 91 days).';
    const sources = [{ source: 'alphavantage' as const, status: 'provider-limited' as const, reason: '', rows: 1 }, { source: 'finnhub' as const, status: 'no-key' as const, reason: '' }];
    serve(earningsDates({ conclusion: { kind: 'broken', text }, lastRun: earningsRun({ status: 'provider-limited', rows: 1, events: 0, matchedHeld: 0, sources }), lastSuccess: null }));
    const section = await card();
    const verdict = section.querySelector('[data-conclusion]')!;
    expect(verdict).toHaveAttribute('data-conclusion', 'broken');
    expect(verdict).toHaveTextContent('No date source is working.');
    expect(verdict).toHaveTextContent('Finnhub is not configured: add a free key (the FINNHUB_API_KEY secret)');
    expect(within(section).getByText(/Last run:/).closest('p')).toHaveTextContent('The provider answered with almost nothing');
    expect(within(section).getByText('Alpha Vantage: answered with almost nothing, 1 row')).toBeInTheDocument();
    expect(within(section).getByText('Finnhub: not configured')).toBeInTheDocument();
    expect(within(section).getByText(/The provider returned 1 rows/)).toBeInTheDocument();
  });

  it('shows a working and a partly working verdict, each source with its outcome, and the conflicts between sources', async () => {
    const sources = [
      { source: 'alphavantage' as const, status: 'rate-limited' as const, reason: 'daily limit', rows: undefined },
      { source: 'finnhub' as const, status: 'ok' as const, reason: '', rows: 800 },
    ];
    const conflicts = [{ symbol: 'AMZN', kept: { source: 'finnhub' as const, date: '2026-11-05' }, dropped: { source: 'alphavantage' as const, date: '2026-11-12' } }];
    serve(earningsDates({ conclusion: { kind: 'partial', text: 'Dates come from Finnhub. Alpha Vantage: rate limit reached (daily limit).' }, lastRun: earningsRun({ sources, conflicts }) }));
    const section = await card();
    expect(section.querySelector('[data-conclusion]')).toHaveAttribute('data-conclusion', 'partial');
    expect(within(section).getByText('Alpha Vantage: rate-limited (daily limit)')).toBeInTheDocument();
    expect(within(section).getByText('Finnhub: read, 800 rows')).toBeInTheDocument();
    expect(within(section).getByText('Sources disagreed: AMZN (kept Finnhub 05-11-2026, dropped Alpha Vantage 12-11-2026).')).toBeInTheDocument();
  });

  it('shows how many held companies Finnhub has a date for, the outcome of each, and the last error', async () => {
    const finnhub = {
      source: 'finnhub' as const,
      status: 'ok' as const,
      reason: 'finnhub: HTTP 500 for [url]',
      rows: 3,
      companies: 4,
      withDate: 2,
      checks: [
        { symbol: 'KMB', result: 'date' as const, date: '2026-11-05' },
        { symbol: 'GOOGL', result: 'none' as const },
        { symbol: 'MMM', result: 'failed' as const, reason: 'finnhub: HTTP 500 for [url]' },
        { symbol: 'ABT', result: 'pending' as const },
      ],
    };
    serve(earningsDates({ lastRun: earningsRun({ sources: [{ source: 'alphavantage', status: 'no-key', reason: '' }, finnhub] }) }));
    const section = await card();
    const details = within(section).getByText('Finnhub: 2 of 4 companies have a date').closest('details')!;
    expect(details.closest('li')).toHaveTextContent('Finnhub: read; last error: finnhub: HTTP 500 for [url]');
    expect(within(details).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['KMB: date 05-11-2026', 'GOOGL: no date yet', 'MMM: failed (finnhub: HTTP 500 for [url])', 'ABT: not asked in this run']);
  });

  it('says a refused key was refused, and what a rate-limited company is', async () => {
    const finnhub = {
      source: 'finnhub' as const,
      status: 'refused' as const,
      reason: 'finnhub: HTTP 401: the key was refused or has no access to the earnings calendar',
      companies: 2,
      withDate: 0,
      checks: [
        { symbol: 'KMB', result: 'refused' as const, reason: 'finnhub: HTTP 401' },
        { symbol: 'NVO', result: 'rate-limited' as const },
      ],
    };
    const text = 'No provider date source is working. Finnhub refused the request (finnhub: HTTP 401): check the FINNHUB_API_KEY secret (it must be a valid key).';
    serve(earningsDates({ conclusion: { kind: 'broken', text }, lastRun: earningsRun({ status: 'failed', sources: [{ source: 'alphavantage', status: 'no-key', reason: '' }, finnhub] }) }));
    const section = await card();
    expect(section.querySelector('[data-conclusion]')).toHaveTextContent('check the FINNHUB_API_KEY secret');
    expect(within(section).getByText('Finnhub: 0 of 2 companies have a date').closest('li')).toHaveTextContent('Finnhub: refused the key (finnhub: HTTP 401: the key was refused or has no access to the earnings calendar)');
    expect(within(section).getByText('KMB: refused the key (finnhub: HTTP 401)')).toBeInTheDocument();
    expect(within(section).getByText('NVO: rate-limited')).toBeInTheDocument();
  });

  it('shows the date kind and the release time in both zones for each company', async () => {
    const confirmed = heldDate({ symbol: 'AMZN', name: 'Amazon', next: { date: '2026-11-05', source: 'scheduled', status: 'CONFIRMED', timeOfDay: 'AMC', releaseText: 'After the close, typically ~16:05 ET = ~22:05 Amsterdam' } });
    const scheduled = heldDate({ symbol: 'KO', name: 'Coca-Cola', next: { date: '2026-11-12', source: 'scheduled', status: 'ESTIMATED', timeOfDay: 'unknown', releaseText: 'Time not announced' } });
    const projected = heldDate({ symbol: 'APP', name: 'AppLovin', next: { date: '2026-11-04', source: 'projected', status: 'ESTIMATED', timeOfDay: 'unknown' } });
    const reported = heldDate({ symbol: 'GOOGL', name: 'Alphabet', next: { date: '2026-10-28', source: 'reported', status: 'CONFIRMED', timeOfDay: 'DMH' } });
    serve(earningsDates({ held: 4, withDate: 4, symbols: [confirmed, scheduled, projected, reported] }));
    const section = await card();
    const table = within(section).getByRole('table');
    const rows = within(table).getAllByRole('row').filter((row) => within(row).queryByRole('rowheader') !== null);
    const first = (row: HTMLElement) => within(row).getAllByRole('cell')[0]!.textContent;
    expect(first(rows[0]!)).toBe('05-11-2026Confirmed · After the close, typically ~16:05 ET = ~22:05 Amsterdam');
    expect(first(rows[1]!)).toBe('12-11-2026Scheduled (provider date) · Time not announced');
    expect(first(rows[2]!)).toBe('04-11-2026Projected');
    expect(first(rows[3]!)).toBe('28-10-2026Reported · during market hours');
  });

  it('queues the calendar job once and says so', async () => {
    serve();
    const user = userEvent.setup();
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Refresh earnings dates now' }));
    expect(await within(section).findByText(/Queued\. The job starts within a minute and then asks Finnhub about one held company every couple of seconds/)).toBeInTheDocument();
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
