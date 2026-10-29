import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { sampleDemoSummaries, sampleSummary, type EarningsLastRun, type EarningsListResponse, type EarningsStatusResponse } from '@portfolio/shared';
import { DEMO_EARNINGS_STATUS, earningsHandlers } from '../mocks/earningsHandlers';
import { api } from '../mocks/utils';
import { server } from '../mocks/server';
import { mainNav, openPortfolioMenu, renderApp } from '../test/utils';
import { titleFor } from '../App';
import { formatDateTime } from '../lib/format';

const status = (patch: Partial<EarningsStatusResponse> = {}): EarningsStatusResponse => ({ ...DEMO_EARNINGS_STATUS, ...patch });
const serveStatus = (value: EarningsStatusResponse) => server.use(http.get(api('/earnings/status'), () => HttpResponse.json(value)));
const serveList = (value: EarningsListResponse) => server.use(http.get(api('/earnings'), () => HttpResponse.json(value)));
const demo = () => server.use(...earningsHandlers);

describe('the Earnings menu entry', () => {
  it('is hidden where the deployment has no earnings (AWS, the default of the tests)', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await openPortfolioMenu(user);
    expect(within(mainNav()).queryByRole('link', { name: 'Earnings' })).not.toBeInTheDocument();
  });

  it('is in the Portfolio menu when the status says available, and opens the page', async () => {
    demo();
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await openPortfolioMenu(user);
    const link = await within(mainNav()).findByRole('link', { name: 'Earnings' });
    await user.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Earnings' })).toBeInTheDocument();
    expect(await screen.findAllByRole('article')).toHaveLength(2);
  });

  it('stays hidden when the status request fails', async () => {
    server.use(http.get(api('/earnings/status'), () => HttpResponse.json({ error: { code: 'X', message: 'x' } }, { status: 500 })));
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    await openPortfolioMenu(user);
    expect(within(mainNav()).queryByRole('link', { name: 'Earnings' })).not.toBeInTheDocument();
  });
});

describe('the page', () => {
  it('lists the cards newest first with a chip per company and filters by symbol', async () => {
    demo();
    const user = userEvent.setup();
    renderApp('/earnings');
    const cards = await screen.findAllByRole('article');
    expect(cards.map((card) => within(card).getByRole('heading', { level: 2 }).textContent)).toEqual(['Harbor Bancorp · Q3 2026', 'Cloudvale Software Inc. · Q2 FY2027']);
    const chips = screen.getByRole('navigation', { name: 'Filter by company' });
    expect(within(chips).getAllByRole('link').map((link) => link.textContent)).toEqual(['All', 'CLDV', 'HBRB']);
    expect(within(chips).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(chips).getByRole('link', { name: 'CLDV' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(1));
    expect(screen.getByRole('heading', { level: 2, name: /Cloudvale/ })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Filter by company' })).getByRole('link', { name: 'CLDV' })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toContain('Earnings');
  });

  it('shows the invented consensus of the demo with its source, range and analysts, and how many companies have it', async () => {
    demo();
    const user = userEvent.setup();
    renderApp('/earnings');
    const [bank, saas] = await screen.findAllByRole('article');
    expect(within(saas!).getAllByText('Consensus: Alpha Vantage')).toHaveLength(2);
    expect(within(saas!).getByText('(31 analysts)')).toBeInTheDocument();
    expect(within(saas!).getByText('(27 analysts)')).toBeInTheDocument();
    expect(within(saas!).getByText(/^Beat by/)).toBeInTheDocument();
    expect(within(saas!).getByText(/^Missed by/)).toBeInTheDocument();
    expect(within(bank!).getAllByText('Revenue: The data provider has no estimate for this figure')).toHaveLength(1);
    expect(within(bank!).getAllByText('n/a')).toHaveLength(2);
    await user.click(screen.getByText('What was checked'));
    expect(screen.getByText('Consensus estimates: 2 of 2 companies.')).toBeInTheDocument();
  });

  it('asks for an immediate check of the filtered symbol, at most once an hour', async () => {
    demo();
    const user = userEvent.setup();
    renderApp('/earnings/CLDV');
    await screen.findAllByRole('article');
    await user.click(screen.getByRole('button', { name: 'Check CLDV now' }));
    expect(await screen.findByText(/Checking the SEC now/)).toBeInTheDocument();
    server.use(http.post(api('/earnings/:symbol/refresh'), () => HttpResponse.json({ accepted: false, reason: 'rate-limited', retryAfterSeconds: 100 })));
    await user.click(screen.getByRole('button', { name: 'Check CLDV now' }));
    expect(await screen.findByText(/Checked less than an hour ago/)).toBeInTheDocument();
    server.use(http.post(api('/earnings/:symbol/refresh'), () => HttpResponse.json({ error: { code: 'X', message: 'Nope' } }, { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'Check CLDV now' }));
    expect(await screen.findByText('Nope')).toBeInTheDocument();
  });

  it('explains what is missing when the feature is not configured, and nothing else', async () => {
    serveStatus(status({ configured: false, missing: ['sec-contact', 'ai-binding'] }));
    renderApp('/earnings');
    expect(await screen.findByRole('heading', { name: 'Earnings summaries are not switched on yet' })).toBeInTheDocument();
    expect(screen.getByText(/SEC_CONTACT/)).toBeInTheDocument();
    expect(screen.getByText(/Workers AI binding/)).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('says the deployment has none (AWS, direct link)', async () => {
    renderApp('/earnings');
    expect(await screen.findByRole('heading', { name: 'Earnings summaries are not available here' })).toBeInTheDocument();
  });

  it('says when nothing was published yet and what was checked', async () => {
    demo();
    serveList({ available: true, summaries: [], symbols: [] });
    serveStatus(status({ symbols: [{ symbol: 'LMFG', eligible: true, lastCheckedAt: '2026-10-21T19:30:00.000Z', lastReason: 'no new release' }, { symbol: 'NEW', eligible: true }, { symbol: 'VWRL', eligible: false }] }));
    renderApp('/earnings');
    expect(await screen.findByRole('heading', { name: 'No earnings summaries yet' })).toBeInTheDocument();
    expect(screen.getByText('What was checked').closest('details')).toHaveAttribute('open');
    expect(screen.getByText(`LMFG: checked ${formatDateTime('2026-10-21T19:30:00.000Z')}, no new release`)).toBeInTheDocument();
    expect(screen.getByText('NEW: not checked yet')).toBeInTheDocument();
    expect(screen.queryByText(/VWRL/)).not.toBeInTheDocument();
  });

  it('explains in one line per company why nothing is stored, with the totals, the last full pass and the progress', async () => {
    demo();
    serveList({ available: true, summaries: [], symbols: [] });
    const run = (stage: EarningsLastRun['stage'], detail: string | undefined, filing?: EarningsLastRun['filing']): EarningsLastRun => ({ at: '2026-10-25T06:30:00.000Z', stage, ...(detail === undefined ? {} : { detail }), ...(filing === undefined ? {} : { filing }) });
    serveStatus(
      status({
        lastFullPassAt: '2026-10-25T06:30:00.000Z',
        notHeld: 94,
        backfill: { status: 'running', quarters: 4, total: 80, done: 34, stored: 30, failed: 4, planned: 18, companies: 20, waitReason: 'allowance', waitUntil: '2026-10-26T00:05:00.000Z' },
        symbols: [
          { symbol: 'MSFT', eligible: true, lastRun: run('ai', 'invalid JSON', { form: '8-K', date: '2026-10-29', accession: 'a-1' }), releases: { planned: 4, stored: 1, failed: 2 } },
          { symbol: 'ASML.AS', eligible: true, lastRun: run('no-release-found', 'no results release found in the last 120 days') },
          { symbol: 'JPM', eligible: true, lastRun: run('sec-blocked', 'blocked by the SEC (HTTP 429)') },
          { symbol: 'FOO.DE', eligible: true, lastRun: run('ticker-map', 'not found in the SEC company list') },
          { symbol: 'VWRL', eligible: false, lastRun: run('not-eligible', 'no quarterly results') },
        ],
        secBlockedUntil: '2026-10-25T09:30:00.000Z',
      }),
    );
    renderApp('/earnings');
    expect(await screen.findByText('MSFT: found 8-K from 29-10-2026, the AI could not read it (invalid JSON) · 1 of 4 quarters stored, 2 could not be read')).toBeInTheDocument();
    expect(screen.getByText('ASML.AS: no results release found in the last 120 days')).toBeInTheDocument();
    expect(screen.getByText(`JPM: blocked by the SEC until ${formatDateTime('2026-10-25T09:30:00.000Z')}`)).toBeInTheDocument();
    expect(screen.getByText('FOO.DE: not found in the SEC company list')).toBeInTheDocument();
    expect(screen.queryByText(/VWRL/)).not.toBeInTheDocument();
    expect(screen.getByText('5 holdings · 4 companies · 0 with a summary · 1 without quarterly results (funds, crypto, ...)')).toBeInTheDocument();
    expect(screen.getByText('Not counted: 94 symbols you no longer hold.')).toBeInTheDocument();
    expect(screen.getByText(`Last full pass: every company was looked at since ${formatDateTime('2026-10-25T06:30:00.000Z')}.`)).toBeInTheDocument();
    expect(screen.getByText(/34 of 80 releases read \(4 could not be read\)\. The SEC list of 2 of 20 companies is not read yet\./)).toBeInTheDocument();
    expect(screen.getByText(/Resumes at 00:00 UTC .* when the daily AI allowance is used up/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Releases read' })).toHaveAttribute('value', '34');
  });

  it('"Fetch all now" asks for the backfill, once an hour, and says what happened', async () => {
    demo();
    serveList({ available: true, summaries: [sampleSummary({ symbol: 'LMFG' })], symbols: ['LMFG'] });
    serveStatus(status({ backfill: { status: 'running', quarters: 4, total: 8, done: 2, stored: 1, failed: 1, planned: 2, companies: 2 } }));
    const user = userEvent.setup();
    renderApp('/earnings');
    await screen.findAllByRole('article');
    const section = screen.getByText('What was checked').closest('details')!;
    expect(section).not.toHaveAttribute('open');
    await user.click(screen.getByText('What was checked'));
    expect(screen.getByText(/also tries the 1 release that could not be read again/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fetch all now' }));
    expect(await screen.findByText(/Started\. The page fills as releases are read/)).toBeInTheDocument();
    server.use(http.post(api('/earnings/backfill'), () => HttpResponse.json({ accepted: false, reason: 'rate-limited', retryAfterSeconds: 100 }, { status: 202 })));
    await user.click(screen.getByRole('button', { name: 'Fetch all now' }));
    expect(await screen.findByText(/Started less than an hour ago/)).toBeInTheDocument();
    server.use(http.post(api('/earnings/backfill'), () => HttpResponse.json({ accepted: false, reason: 'not-configured' }, { status: 202 })));
    await user.click(screen.getByRole('button', { name: 'Fetch all now' }));
    expect(await screen.findByText(/Not switched on on the server yet/)).toBeInTheDocument();
    server.use(http.post(api('/earnings/backfill'), () => HttpResponse.json({ error: { code: 'X', message: 'Nope' } }, { status: 500 })));
    await user.click(screen.getByRole('button', { name: 'Fetch all now' }));
    expect(await screen.findByText('Nope')).toBeInTheDocument();
  });

  it('says when the SEC asked to slow down and when the AI allowance is used up, above the cards', async () => {
    demo();
    serveStatus(status({ secBlockedUntil: '2026-10-21T21:00:00.000Z', neurons: { used: 6100, dailyCap: 6000, allowance: 10_000, state: 'warn', resetsAt: '2026-10-22T00:00:00.000Z' } }));
    renderApp('/earnings');
    expect(await screen.findAllByRole('article')).toHaveLength(2);
    const notes = screen.getAllByRole('status');
    expect(notes[0]).toHaveTextContent(`The SEC asked us to slow down, so lookups are paused until ${formatDateTime('2026-10-21T21:00:00.000Z')}.`);
    expect(notes[1]).toHaveTextContent(/free Workers AI allowance.*used up \(6100 of 6000 neurons\).*after 00:00 UTC/);
  });

  it('shows an error with a retry for the list and for the status', async () => {
    demo();
    server.use(http.get(api('/earnings'), () => HttpResponse.json({ error: { code: 'X', message: 'List broke' } }, { status: 500 })));
    renderApp('/earnings');
    expect(await screen.findByText('List broke')).toBeInTheDocument();
    server.use(http.get(api('/earnings/status'), () => HttpResponse.json({ error: { code: 'X', message: 'Status broke' } }, { status: 500 })));
    renderApp('/earnings');
    expect((await screen.findAllByText('Status broke')).length).toBeGreaterThan(0);
  });

  it('titles the route of a symbol', () => {
    expect(titleFor('/earnings')).toBe('Earnings');
    expect(titleFor('/earnings/LMT')).toBe('LMT · Earnings');
    expect(titleFor('/earnings/%E0%A4%A')).toBe('Earnings');
    expect(titleFor('/earnings/')).toBe('Not found');
  });

  it('renders a symbol with a dot in its route', async () => {
    demo();
    serveList({ available: true, summaries: [sampleSummary({ symbol: 'NRDV.AS', name: 'Nordvik', reportingCurrency: 'EUR' })], symbols: ['NRDV.AS'] });
    renderApp('/earnings/NRDV.AS');
    expect(await screen.findByRole('heading', { level: 2, name: /Nordvik/ })).toBeInTheDocument();
    expect(sampleDemoSummaries()).toHaveLength(2);
  });
});

describe('the card layout', () => {
  const cardOrder = () => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId);

  it('keeps the summaries above what was checked and puts the customize toggle in the page header, next to the refresh button', async () => {
    demo();
    renderApp('/earnings/CLDV');
    await screen.findAllByRole('article');
    expect(cardOrder()).toEqual(['earnings-summaries', 'earnings-checked']);
    const actions = document.querySelector<HTMLElement>('[data-page-header-actions]')!;
    expect(within(actions).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: 'Check CLDV now' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Filter by company' })).toBeInTheDocument();
  });

  it('moves the checked section above the summaries and can hide it', async () => {
    demo();
    const user = userEvent.setup();
    renderApp('/earnings');
    await screen.findAllByRole('article');
    await user.click(screen.getByRole('button', { name: 'Customize layout' }));
    await user.click(screen.getByRole('button', { name: 'Move What was checked up' }));
    expect(cardOrder()).toEqual(['earnings-checked', 'earnings-summaries']);

    await user.click(screen.getByRole('button', { name: 'Hide What was checked' }));
    expect(cardOrder()).toEqual(['earnings-summaries']);
    expect(screen.getByRole('button', { name: 'Show What was checked' })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });
});
