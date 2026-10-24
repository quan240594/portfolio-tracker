import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { report } from '../../test/diagnostics';
import { localDateTime } from '../../test/localTime';
import { coverage, pricesStatus, symbolRow } from '../../test/priceCoverage';
import { renderApp, renderWithProviders } from '../../test/utils';
import { DiagnosticsView } from './DiagnosticsView';
import { PriceCoverageCard } from './PriceCoverageCard';

const serve = (body: Record<string, unknown> = pricesStatus()) => {
  server.use(http.get(api('/diagnostics/alarms'), () => HttpResponse.json(report())), http.get(api('/prices/status'), () => HttpResponse.json(body)));
};

describe('Price data coverage card', () => {
  it('lists each held symbol with its state as text, rows, first and last day and the reason, worst first', async () => {
    serve();
    renderWithProviders(<DiagnosticsView />);
    const card = await screen.findByRole('region', { name: 'Price data coverage' });
    expect(card).toHaveAttribute('id', 'price-coverage');
    expect(within(card).getByText(/3 held symbols: 1 complete, 1 partial, 1 missing\./)).toBeInTheDocument();
    expect(within(card).getByText(/values the symbols without prices at their cost from 05-01-2026 until 23-10-2026/)).toBeInTheDocument();

    const table = within(card).getByRole('table', { name: 'Stored price history per held symbol, worst first' });
    // each symbol has a second row for narrow screens (hidden by CSS from 768 px on)
    const rows = within(table)
      .getAllByRole('row')
      .filter((row) => within(row).queryByRole('rowheader') !== null);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      expect.stringContaining('NOVO-B.CO'),
      expect.stringContaining('MSFT'),
      expect.stringContaining('ASML.AS'),
    ]);
    const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells(rows[0]!).slice(0, 5)).toEqual(['Missing', '0', '–', '–', expect.stringContaining('No provider key for this exchange')]);
    expect(cells(rows[1]!).slice(0, 4)).toEqual(['Partial', '40', '01-09-2026', '23-10-2026']);
    expect(cells(rows[1]!)[4]).toContain('Daily quota used up, retries after reset');
    expect(cells(rows[1]!)[4]).toContain('Last attempt 22-10-2026: 2 tries, will retry (Daily credits exhausted)');
    expect(cells(rows[2]!).slice(0, 4)).toEqual(['Complete', '252', '23-10-2025', '23-10-2026']);
    expect(cells(rows[2]!)[4]).toContain('Last quote 23-10-2026');
    expect(cells(rows[2]!)[4]).toContain('(t212)');
    expect(cells(rows[0]!)[4]).toContain('No quote stored');
    expect(within(card).getByText(/Read for this report: 330 stored rows/)).toBeInTheDocument();
  });

  it('marks a capped row count with a plus, singular wording, truncation and an empty state', () => {
    const { unmount } = renderWithProviders(
      <PriceCoverageCard
        coverage={coverage({
          symbols: [symbolRow({ eodRows: 400, eodRowsCapped: true, lastAttempt: { day: '2026-10-22', attempts: 1, outcome: 'skipped', error: '' } })],
          totals: { held: 61, complete: 1, partial: 0, missing: 0, valuedAtCostSince: null, valuedAtCostUntil: null, truncated: true },
        })}
      />,
    );
    expect(screen.getByText('400+')).toBeInTheDocument();
    expect(screen.getByText(/61 held symbols: 1 complete, 0 partial, 0 missing\. The first 1 are listed\./)).toBeInTheDocument();
    expect(screen.getByText('Every held symbol has prices for the whole chart.')).toBeInTheDocument();
    expect(screen.getAllByText('Last attempt 22-10-2026: 1 try, skipped').length).toBeGreaterThan(0);
    unmount();

    renderWithProviders(
      <PriceCoverageCard coverage={coverage({ symbols: [], totals: { held: 1, complete: 0, partial: 0, missing: 0, valuedAtCostSince: null, valuedAtCostUntil: null, truncated: false } })} />,
    );
    expect(screen.getByText('1 held symbol: 0 complete, 0 partial, 0 missing.')).toBeInTheDocument();
    expect(screen.getByText('No open positions to check.')).toBeInTheDocument();
  });

  it('shows a quote that has no source', async () => {
    renderWithProviders(<PriceCoverageCard coverage={coverage({ symbols: [symbolRow({ lastQuoteSource: null })] })} />);
    expect(screen.getAllByText(`Last quote ${localDateTime('2026-10-23T08:15:00.000Z')}`).length).toBeGreaterThan(0);
  });

  it('is absent when the Hub does not report it, and the alarm log still shows', async () => {
    serve({ state: 'ok', sources: [] });
    renderWithProviders(<DiagnosticsView />);
    expect(await screen.findByRole('region', { name: 'Last 24 hours' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Price data coverage' })).not.toBeInTheDocument();
  });

  it('says so when the coverage cannot be read, and recovers on a retry', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get(api('/diagnostics/alarms'), () => HttpResponse.json(report())),
      http.get(api('/prices/status'), () => {
        calls += 1;
        return calls === 1 ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(pricesStatus());
      }),
    );
    renderWithProviders(<DiagnosticsView />);
    const failed = await screen.findByRole('region', { name: 'Price data coverage' });
    expect(failed).toHaveTextContent('could not be read');
    await user.click(within(failed).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/3 held symbols/)).toBeInTheDocument();
  });

  it('is read again by the Refresh button together with the alarm log', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get(api('/diagnostics/alarms'), () => HttpResponse.json(report())),
      http.get(api('/prices/status'), () => {
        calls += 1;
        return HttpResponse.json(pricesStatus(calls === 1 ? coverage() : coverage({ rowsRead: 999 })));
      }),
    );
    renderWithProviders(<DiagnosticsView />);
    await screen.findByText(/330 stored rows/);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/999 stored rows/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });

  it('scrolls to the card when the page is opened at #price-coverage', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    serve();
    renderApp('/settings/diagnostics#price-coverage');
    await screen.findByRole('region', { name: 'Price data coverage' });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
  });

  it('is not shown where the alarm log is not available either (the demo, the AWS deployment)', async () => {
    renderWithProviders(<DiagnosticsView />);
    expect(await screen.findByRole('heading', { name: 'Diagnostics are not available' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Price data coverage' })).not.toBeInTheDocument();
  });
});
