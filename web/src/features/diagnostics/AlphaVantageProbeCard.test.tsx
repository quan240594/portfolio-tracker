import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { report } from '../../test/diagnostics';
import { earningsDates } from '../../test/earningsDates';
import { pricesStatus } from '../../test/priceCoverage';
import { renderWithProviders } from '../../test/utils';
import { AlphaVantageProbeCard } from './AlphaVantageProbeCard';
import { DiagnosticsView } from './DiagnosticsView';
import { useAlphaVantageProbe } from './useAlphaVantageProbe';

const mocks = vi.hoisted(() => ({ useMocks: false }));
vi.mock('../../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config')>()),
  get USE_MOCKS() {
    return mocks.useMocks;
  },
}));

const budget = { provider: 'Alpha Vantage', day: '2026-10-29', used: 2, limit: 25, remaining: 23, calendarUsed: 1, calendarLimit: 1 };
const VOLUME = 'Thank you for using Alpha Vantage! Please contact premium@alphavantage.co if you are targeting a higher API call volume.';
const result = (over: Record<string, unknown> = {}) => ({ at: '2026-10-29T08:20:00.000Z', symbol: 'IBM', call: 'EARNINGS_ESTIMATES', outcome: 'ok', summary: 'ok: 12 quarters', quarters: 12, ...over });
const status = (over: Record<string, unknown> = {}) => ({ available: true, reason: null, nextAllowedAt: null, budget, last: null, ...over });

const posts: string[] = [];

function serve(probe: Record<string, unknown> | number, run: () => Response = () => HttpResponse.json({ ...result(), budget })) {
  posts.length = 0;
  server.use(
    http.get(api('/diagnostics/alarms'), () => HttpResponse.json(report())),
    http.get(api('/prices/status'), () => HttpResponse.json(pricesStatus())),
    http.get(api('/diagnostics/earnings-dates'), () => HttpResponse.json(earningsDates())),
    http.get(api('/diagnostics/alphavantage-probe'), () => (typeof probe === 'number' ? new HttpResponse(null, { status: probe }) : HttpResponse.json(probe))),
    http.post(api('/diagnostics/alphavantage-probe'), () => {
      posts.push('asked');
      return run();
    }),
  );
}

async function card() {
  renderWithProviders(<DiagnosticsView />);
  return screen.findByRole('region', { name: 'Alpha Vantage' });
}

describe('Alpha Vantage test card', () => {
  it('has a button and says nothing was run yet, with the allowance of the day', async () => {
    serve(status());
    const section = await card();
    expect(section).toHaveAttribute('id', 'alphavantage-probe');
    expect(within(section).getByRole('button', { name: 'Test Alpha Vantage now' })).toBeEnabled();
    expect(within(section).getByText('Not run yet.')).toBeInTheDocument();
    expect(within(section).getByText('Today (UTC): 2 of 25 requests used by this app.')).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('runs the test on a click and shows the outcome and the provider\u2019s own words', async () => {
    serve(status(), () => HttpResponse.json({ ...result({ outcome: 'rate-limited', summary: 'rate limit (unspecified): the provider asked to slow down', message: VOLUME, quarters: undefined }), budget: { ...budget, used: 3 } }));
    const user = userEvent.setup();
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Test Alpha Vantage now' }));
    await waitFor(() => expect(within(section).getByText('rate limit (unspecified): the provider asked to slow down')).toBeInTheDocument());
    expect(within(section).getByText(VOLUME)).toBeInTheDocument();
    expect(within(section).getByText(/EARNINGS_ESTIMATES for IBM, /)).toBeInTheDocument();
    expect(within(section).getByText('Today (UTC): 3 of 25 requests used by this app.')).toBeInTheDocument();
    expect(posts).toEqual(['asked']);
  });

  it('shows both outcomes side by side and the plain conclusion, and the words of the control when it was refused', async () => {
    const conclusion = { kind: 'estimates-unavailable', text: 'Your key can read EARNINGS but not EARNINGS_ESTIMATES: estimates (and revenue consensus) need a paid Alpha Vantage plan.' };
    const comparison = 'EARNINGS_ESTIMATES: refused (generic limit text) / EARNINGS: ok, 80 quarters';
    const control = { call: 'EARNINGS', outcome: 'ok', summary: 'ok: 80 quarters', quarters: 80 };
    serve(status(), () => HttpResponse.json({ ...result({ outcome: 'rate-limited', summary: 'rate limit (unspecified): the provider asked to slow down', message: VOLUME, quarters: undefined, control, comparison, conclusion }), budget: { ...budget, used: 4 } }));
    const user = userEvent.setup();
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Test Alpha Vantage now' }));
    expect(await within(section).findByText(conclusion.text)).toBeInTheDocument();
    expect(within(section).getByText(comparison)).toBeInTheDocument();
    expect(within(section).getByText(VOLUME)).toBeInTheDocument();
    expect(within(section).getByText(/EARNINGS_ESTIMATES and EARNINGS for IBM, /)).toBeInTheDocument();
    expect(within(section).queryByText(/Alpha Vantage says \(EARNINGS\)/)).not.toBeInTheDocument();
  });

  it('shows what Alpha Vantage said to the control call when it was refused too', async () => {
    const control = { call: 'EARNINGS', outcome: 'rate-limited', summary: 'rate limit (unspecified): the provider asked to slow down', message: VOLUME };
    serve(status({ last: result({ outcome: 'rate-limited', summary: 'x', message: VOLUME, control, comparison: 'EARNINGS_ESTIMATES: refused (generic limit text) / EARNINGS: refused (generic limit text)', conclusion: { kind: 'throttled', text: 'Both calls were limited: you are being throttled, try later.' } }) }));
    const section = await card();
    expect(within(section).getByText('Both calls were limited: you are being throttled, try later.')).toBeInTheDocument();
    expect(within(section).getByText(/Alpha Vantage says \(EARNINGS\)/)).toBeInTheDocument();
    expect(within(section).getAllByText(VOLUME)).toHaveLength(2);
  });

  it('shows the last result of an earlier test and a good outcome as good news', async () => {
    serve(status({ last: result() }));
    const section = await card();
    expect(within(section).getByText('ok: 12 quarters')).toBeInTheDocument();
    expect(within(section).queryByText('Not run yet.')).not.toBeInTheDocument();
    expect(within(section).queryByText(/Alpha Vantage says/)).not.toBeInTheDocument();
  });

  it('disables the button and says why when the test may not run now', async () => {
    serve(status({ available: false, reason: 'The test ran at 09:00 UTC; you can run it again after 09:10 UTC (once every 10 minutes).', nextAllowedAt: '2026-10-29T09:10:00.000Z' }));
    const section = await card();
    expect(within(section).getByRole('button', { name: 'Test Alpha Vantage now' })).toBeDisabled();
    expect(within(section).getByText(/you can run it again after 09:10 UTC/)).toBeInTheDocument();
  });

  it('shows the reason of a refusal that came after the click', async () => {
    serve(status(), () => HttpResponse.json({ error: { code: 'RATE_LIMITED', message: 'Alpha Vantage allowance nearly used: 23 of 25 calls today (UTC).' } }, { status: 429 }));
    const user = userEvent.setup();
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Test Alpha Vantage now' }));
    expect(await within(section).findByText(/allowance nearly used: 23 of 25/)).toBeInTheDocument();
  });

  it('says the test could not be run after a server failure', async () => {
    serve(status(), () => new HttpResponse(null, { status: 500 }));
    const user = userEvent.setup();
    const section = await card();
    await user.click(within(section).getByRole('button', { name: 'Test Alpha Vantage now' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent('The test could not be run. Try again later.');
  });

  it('is not shown where the deployment has no such test', async () => {
    serve(404);
    renderWithProviders(<DiagnosticsView />);
    await screen.findByRole('region', { name: 'Earnings dates' });
    expect(screen.queryByRole('region', { name: 'Alpha Vantage' })).not.toBeInTheDocument();
  });
});

function Standalone() {
  const probe = useAlphaVantageProbe();
  return <AlphaVantageProbeCard probe={probe} />;
}

describe('Alpha Vantage test card in mock mode', () => {
  afterEach(() => {
    mocks.useMocks = false;
  });

  it('shows a sample answer and never calls the backend', async () => {
    mocks.useMocks = true;
    posts.length = 0;
    server.use(http.post(api('/diagnostics/alphavantage-probe'), () => {
      posts.push('asked');
      return HttpResponse.json({});
    }));
    const user = userEvent.setup();
    renderWithProviders(<Standalone />);
    const section = await screen.findByRole('region', { name: 'Alpha Vantage' });
    expect(within(section).getByText('Not run yet.')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Test Alpha Vantage now' }));
    expect(await within(section).findByText(/Sample, no call was made\./)).toBeInTheDocument();
    expect(within(section).getByText(/higher API call volume/)).toBeInTheDocument();
    expect(within(section).getByText(/Your key can read EARNINGS but not EARNINGS_ESTIMATES/)).toBeInTheDocument();
    expect(within(section).getByText('EARNINGS_ESTIMATES: refused (generic limit text) / EARNINGS: ok, 80 quarters')).toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('shows nothing while the status is loading and where the backend does not expose it', async () => {
    server.use(http.get(api('/diagnostics/alphavantage-probe'), () => new HttpResponse(null, { status: 404 })));
    renderWithProviders(<Standalone />);
    expect(screen.queryByRole('region', { name: 'Alpha Vantage' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Alpha Vantage' })).not.toBeInTheDocument());
  });

  it('shows nothing when the status cannot be read', async () => {
    server.use(http.get(api('/diagnostics/alphavantage-probe'), () => new HttpResponse(null, { status: 500 })));
    renderWithProviders(<Standalone />);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Alpha Vantage' })).not.toBeInTheDocument());
  });
});
