import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { report } from '../../test/diagnostics';
import { pricesStatus } from '../../test/priceCoverage';
import { valuationDay, valuationLine, valuationReport } from '../../test/valuationReport';
import { renderWithProviders } from '../../test/utils';
import { DiagnosticsView } from './DiagnosticsView';
import { ValuationReportCard } from './ValuationReportCard';

const asked: (string | null)[] = [];
const serve = (body: number | ReturnType<typeof valuationReport> = valuationReport()) => {
  asked.length = 0;
  server.use(
    http.get(api('/diagnostics/alarms'), () => HttpResponse.json(report())),
    http.get(api('/prices/status'), () => HttpResponse.json(pricesStatus())),
    http.get(api('/diagnostics/valuation'), ({ request }) => {
      asked.push(new URL(request.url).searchParams.get('dates'));
      return typeof body === 'number' ? new HttpResponse(null, { status: body }) : HttpResponse.json(body);
    }),
  );
};

async function open() {
  const user = userEvent.setup();
  renderWithProviders(<ValuationReportCard />);
  await user.click(screen.getByRole('button', { name: 'Show reconciliation' }));
  return { user, card: screen.getByRole('region', { name: 'Chart reconciliation' }) };
}

describe('Chart reconciliation card', () => {
  it('reads nothing until asked, then shows the last day with its totals and the largest gaps first', async () => {
    serve();
    const { card } = await open();
    expect(await within(card).findByText('Chart value')).toBeInTheDocument();
    expect(asked).toEqual([null]);
    const totals = within(card).getByText('Chart value').closest('dl')!;
    expect(totals).toHaveTextContent('Chart value€ 64.012,50');
    expect(totals).toHaveTextContent('Sum of the lines€ 63.012,50');
    expect(totals).toHaveTextContent('Cash and custom assets€ 1.000,00');
    expect(totals).toHaveTextContent('Chart minus fair€ −987,50');
    expect(totals).toHaveTextContent('Invested€ 55.010,00');
    expect(totals).toHaveTextContent('Headline total today€ 64.012,50');

    const table = within(card).getByRole('table', { name: 'Value per held symbol on 25-10-2026, the largest gap first' });
    const symbols = within(table).getAllByRole('rowheader').map((cell) => cell.textContent);
    expect(symbols).toEqual(['IITU.L', 'FWRA.MI', 'ADB.DE', 'AMZN']);
    const body = table.textContent!.replaceAll('\u00a0', ' ');
    expect(body).toContain('140 × 52 USD (close of 24-10-2026)');
    expect(body).toContain('rescaled');
    expect(body).toContain('at cost');
    expect(body).toContain('1.000 × 9,5 EUR (cost fallback)');
    expect(body).toContain('carried 6 d');
    expect(body).toContain('old close');
    expect(body).toContain('other-day FX');
    expect(body).toContain('FX 1,10 (23-10-2026)');
    expect(body).toContain('not held today');
    expect(body).toContain('today € 6.700,00');
  });

  it('lists the FX history with the days that use another day’s rate', async () => {
    serve();
    const { card } = await open();
    const fx = (await within(card).findByRole('heading', { name: 'FX history' })).parentElement!;
    expect(fx).toHaveTextContent('USD: 134 fixings, 02-02-2026 to 23-10-2026; 383 days use another day\'s rate');
    expect(fx).toHaveTextContent('GBP: no stored fixings, the latest rate is used for every day; 1 day uses another day\'s rate');
  });

  it('switches between the days and offers another day, and can go back', async () => {
    serve();
    const { user, card } = await open();
    await within(card).findByText('Chart value');
    const group = within(card).getByRole('group', { name: 'Day' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['25-04-2026', '24-10-2026', '25-10-2026']);
    expect(within(group).getByRole('button', { name: '25-10-2026' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(group).getByRole('button', { name: '25-04-2026' }));
    expect(within(group).getByRole('button', { name: '25-04-2026' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(card).getByText('Chart value').closest('dl')).toHaveTextContent('Chart value€ 33.000,00');
    expect(within(card).queryByRole('button', { name: 'Last days' })).not.toBeInTheDocument();

    server.use(http.get(api('/diagnostics/valuation'), ({ request }) => {
      asked.push(new URL(request.url).searchParams.get('dates'));
      return HttpResponse.json(valuationReport({ days: [valuationDay('2026-01-10', [valuationLine()])] }));
    }));
    await user.type(within(card).getByLabelText('Other day'), '2026-01-10');
    await waitFor(() => expect(asked).toContain('2026-01-10'));
    expect(await within(card).findByRole('button', { name: '10-01-2026' })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Last days' }));
    expect(await within(card).findByRole('button', { name: '25-10-2026' })).toBeInTheDocument();
  });

  it('shows the first lines and the rest on request, and says when symbols were left out', async () => {
    const many = Array.from({ length: 15 }, (_, i) => valuationLine({ symbol: `S${String(i).padStart(2, '0')}`, gap: 15 - i, priceDate: null, ageDays: null, source: 'cost' }));
    serve(valuationReport({ days: [valuationDay('2026-10-25', many)], truncated: true, symbolsTotal: 75, headline: null }));
    const { user, card } = await open();
    expect(await within(card).findAllByRole('rowheader')).toHaveLength(12);
    expect(card).toHaveTextContent('75 symbols are held: only the first 60 are listed');
    expect(card).not.toHaveTextContent('Headline total today');
    await user.click(within(card).getByRole('button', { name: 'Show all 15' }));
    expect(within(card).getAllByRole('rowheader')).toHaveLength(15);
    await user.click(within(card).getByRole('button', { name: 'Show fewer' }));
    expect(within(card).getAllByRole('rowheader')).toHaveLength(12);
  });

  it('describes a close of another currency and a price of zero', async () => {
    serve(valuationReport({ days: [valuationDay('2026-10-25', [valuationLine({ priceCurrency: 'GBP', flags: ['currency'], price: 0 }), valuationLine({ symbol: 'X', fxFallback: 'latest', flags: ['fx'], fxDate: null })])], fx: [] }));
    const { card } = await open();
    await within(card).findByText('close in GBP');
    expect(card).toHaveTextContent('10 × 0 GBP');
    expect(card).toHaveTextContent('latest FX');
    expect(within(card).queryByRole('heading', { name: 'FX history' })).not.toBeInTheDocument();
  });

  it('says there is nothing to reconcile without holdings', async () => {
    serve(valuationReport({ days: [] }));
    const { card } = await open();
    expect(await within(card).findByText(/nothing to reconcile/)).toBeInTheDocument();
  });

  it('says so when the deployment has no such report, and when it cannot be read', async () => {
    serve(404);
    const first = await open();
    expect(await within(first.card).findByText('This deployment has no chart reconciliation.')).toBeInTheDocument();
  });

  it('reports a failed read', async () => {
    serve(500);
    const { card } = await open();
    expect(await within(card).findByText(/could not be read/)).toBeInTheDocument();
  });

  it('sits on the Diagnostics page below the price coverage and is not read until opened', async () => {
    serve();
    renderWithProviders(<DiagnosticsView />);
    expect(await screen.findByRole('region', { name: 'Price data coverage' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Chart reconciliation' })).toBeInTheDocument();
    expect(asked).toEqual([]);
  });
});
