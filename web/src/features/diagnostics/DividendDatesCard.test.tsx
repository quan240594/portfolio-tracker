import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { report } from '../../test/diagnostics';
import { dividendDates, heldDividend, NO_CHECK } from '../../test/dividendDates';
import { pricesStatus } from '../../test/priceCoverage';
import { renderWithProviders } from '../../test/utils';
import { DiagnosticsView } from './DiagnosticsView';

const checks: string[] = [];

function serve(body: ReturnType<typeof dividendDates> | number = dividendDates(), check: Response | (() => Response) = () => HttpResponse.json({ accepted: true }, { status: 202 })) {
  checks.length = 0;
  server.use(
    http.get(api('/diagnostics/alarms'), () => HttpResponse.json(report())),
    http.get(api('/prices/status'), () => HttpResponse.json(pricesStatus())),
    http.get(api('/diagnostics/dividend-dates'), () => (typeof body === 'number' ? new HttpResponse(null, { status: body }) : HttpResponse.json(body))),
    http.post(api('/diagnostics/dividend-dates/refresh'), () => {
      checks.push('asked');
      return typeof check === 'function' ? check() : check;
    }),
  );
}

async function card() {
  renderWithProviders(<DiagnosticsView />);
  return screen.findByRole('region', { name: 'Dividend dates' });
}

describe('Dividend dates card', () => {
  it('says how many held symbols have a declared upcoming dividend, the EODHD allowance and the state of the fallback', async () => {
    serve();
    const section = await card();
    expect(section).toHaveAttribute('id', 'dividend-dates');
    expect(within(section).getByText('1 of 3 held symbols have a declared upcoming dividend.')).toBeInTheDocument();
    expect(within(section).getByText(/EODHD today \(UTC\): 6 of 20 calls used; the daily rotation may use 8 \(2 used\)\./)).toBeInTheDocument();
    expect(within(section).getByText(/Free fallback \(Alpha Vantage dividends\): not tried yet/)).toBeInTheDocument();
  });

  it('lists the symbols without a declared date first, with the reason, the check and the dates of the others', async () => {
    serve();
    const section = await card();
    const table = within(section).getByRole('table', { name: 'Next dividend per held symbol, the ones without a declared date first' });
    const heads = within(table).getAllByRole('rowheader').map((cell) => cell.textContent);
    expect(heads).toEqual([expect.stringContaining('KO'), expect.stringContaining('VWRL.AS'), expect.stringContaining('HESM')]);
    expect(table).toHaveTextContent('Next: none stored');
    expect(table).toHaveTextContent('Skipped on 2026-11-05');
    expect(table).toHaveTextContent('Latest stored: ex 15-09-2026');
    expect(table).toHaveTextContent('Ex 18-12-2026 · pays 05-01-2027');
    expect(table).toHaveTextContent('Projected · amount not known · projected from your payments');
    expect(table).toHaveTextContent('Ex 05-11-2026 · pays 13-11-2026');
    expect(table).toHaveTextContent('Declared · 0.7152 USD per share · EODHD');
    expect(table).toHaveTextContent('Not checked yet');
    expect(table).toHaveTextContent('latest attempt');
    expect(table).toHaveTextContent('skipped: the day’s allowance was spent first (EODHD)');
  });

  it('marks a dividend date the owner entered and one found by the fallback, and reports a failure with its cause', async () => {
    const own = heldDividend({ symbol: 'AAA', name: 'Aaa', next: { exDate: '2026-11-20', payDate: null, amount: null, currency: 'USD', source: 'manual', kind: 'declared', enteredByYou: true }, last: null, check: NO_CHECK });
    const feed = heldDividend({ symbol: 'BBB', name: 'Bbb', next: { exDate: '2026-11-21', payDate: '2026-11-30', amount: 1, currency: 'USD', source: 'alphavantage', kind: 'declared', enteredByYou: false }, check: { checkedAt: '2026-11-05T05:30:00.000Z', attemptAt: '2026-11-05T05:30:00.000Z', outcome: 'ok', reason: '', source: 'alphavantage', events: 2 } });
    const failed = heldDividend({ symbol: 'CCC', name: 'Ccc', next: null, last: null, check: { checkedAt: null, attemptAt: '2026-11-05T05:30:00.000Z', outcome: 'failed', reason: 'HTTP 500', source: 'eodhd', events: 0 }, reasonCode: 'failed', reason: 'The check failed.' });
    const unknown = heldDividend({ symbol: 'DDD', name: 'Ddd', next: { exDate: null, payDate: null, amount: 2, currency: null, source: 'something', kind: 'declared', enteredByYou: false }, last: null, check: { ...NO_CHECK, checkedAt: '2026-11-01T05:30:00.000Z' } });
    serve(dividendDates({ held: 4, withDeclared: 3, symbols: [failed, own, feed, unknown] }));
    const section = await card();
    expect(section).toHaveTextContent('Declared · amount not known · entered by you (entered by you)');
    expect(section).toHaveTextContent('Declared · 1 USD per share · Alpha Vantage');
    expect(section).toHaveTextContent('never read successfully; latest attempt');
    expect(section).toHaveTextContent('failed (EODHD) – HTTP 500');
    expect(section).toHaveTextContent('Ex-date unknown');
    expect(section).toHaveTextContent('Declared · 2 per share · something');
    expect(section).toHaveTextContent('last read 01-11-2026');
  });

  it('describes the fallback feed: available, unavailable with the retry time, off without a key', async () => {
    serve(dividendDates({ feed: { source: 'Alpha Vantage', status: 'unavailable', at: '2026-11-03T05:30:00.000Z', retryAt: '2026-11-10T05:30:00.000Z', reason: 'premium endpoint' } }));
    const section = await card();
    expect(section).toHaveTextContent('not available on your key');
    expect(section).toHaveTextContent(': premium endpoint. It is tried again after');
  });

  it.each([
    ['available', 'works on your key'],
    ['no-key', 'off (no Alpha Vantage key)'],
  ] as const)('shows the feed as %s', async (status, text) => {
    serve(dividendDates({ feed: { source: 'Alpha Vantage', status, at: null, retryAt: null, reason: '' } }));
    expect(await card()).toHaveTextContent(text);
  });

  it('queues a check once and says what to expect; a refusal shows its reason', async () => {
    const user = userEvent.setup();
    serve();
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Check dividends now' }));
    expect(await within(section).findByText(/Queued\. The check starts within a minute/)).toBeInTheDocument();
    expect(checks).toEqual(['asked']);
  });

  it('shows the reason of a refusal and why the button is off', async () => {
    const user = userEvent.setup();
    serve(dividendDates(), () => HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'Ask again after 10:00 UTC.' } }, { status: 429 }));
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Check dividends now' }));
    expect(await within(section).findByText('Ask again after 10:00 UTC.')).toBeInTheDocument();
  });

  it('disables the button with the reason when a check is not possible, and says when the call could not be made', async () => {
    serve(dividendDates({ refresh: { available: false, reason: 'EODHD allowance spent: 18 of 20 calls today.', nextAllowedAt: '2026-11-06T00:00:00.000Z' } }));
    const section = await card();
    expect(within(section).getByRole('button', { name: 'Check dividends now' })).toBeDisabled();
    expect(within(section).getByText('EODHD allowance spent: 18 of 20 calls today.')).toBeInTheDocument();
  });

  it('says so when the check could not be queued', async () => {
    const user = userEvent.setup();
    serve(dividendDates(), () => new HttpResponse(null, { status: 500 }));
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Check dividends now' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('could not be queued');
  });

  it('is absent where the backend has no such report, and offers a retry where it could not be read', async () => {
    serve(404);
    renderWithProviders(<DiagnosticsView />);
    await screen.findByRole('region', { name: 'Last 24 hours' });
    expect(screen.queryByRole('region', { name: 'Dividend dates' })).not.toBeInTheDocument();
  });

  it('shows a retry for a report that could not be read', async () => {
    const user = userEvent.setup();
    serve(500);
    renderWithProviders(<DiagnosticsView />);
    const section = await screen.findByRole('region', { name: 'Dividend dates' });
    expect(within(section).getByText('The dividend dates could not be read.')).toBeInTheDocument();
    serve(dividendDates());
    await user.click(within(section).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('1 of 3 held symbols have a declared upcoming dividend.')).toBeInTheDocument());
  });

  it('says there is nothing to check without a held payer', async () => {
    serve(dividendDates({ held: 0, withDeclared: 0, symbols: [] }));
    expect(await card()).toHaveTextContent('No held symbol can pay a dividend.');
  });
});
