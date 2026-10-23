import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { sampleSummary } from '@portfolio/shared';
import { DEMO_EARNINGS_STATUS } from '../../mocks/earningsHandlers';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { renderApp, renderWithProviders } from '../../test/utils';
import { SummaryLink } from './SummaryLink';

const available = (summaries = [sampleSummary({ symbol: 'AAPL', name: 'Apple Inc.', reportDate: '2026-10-21' })]) =>
  server.use(
    http.get(api('/earnings/status'), () => HttpResponse.json(DEMO_EARNINGS_STATUS)),
    http.get(api('/earnings'), () => HttpResponse.json({ available: true, summaries, symbols: summaries.map((summary) => summary.symbol) })),
  );

describe('Latest earnings on the asset detail page', () => {
  it('shows the newest summary compactly with a link to all of them', async () => {
    available();
    renderApp('/assets/AAPL?portfolio=all');
    const section = await screen.findByRole('region', { name: 'Latest earnings' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Apple Inc. · Q3 2026' })).toBeInTheDocument();
    expect(within(section).getByRole('table')).toBeInTheDocument();
    expect(within(section).queryByText('Cash flow')).not.toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'All earnings summaries of AAPL' })).toHaveAttribute('href', '/earnings/AAPL');
  });

  it('renders nothing where the feature is not available or when there is no summary yet', async () => {
    renderApp('/assets/AAPL?portfolio=all');
    await screen.findByRole('heading', { level: 1, name: 'Apple Inc.' });
    expect(screen.queryByText('Latest earnings')).not.toBeInTheDocument();
  });

  it('renders nothing for a security without a summary, and not for a deployment that is not configured', async () => {
    available([]);
    renderApp('/assets/AAPL?portfolio=all');
    await screen.findByRole('heading', { level: 1, name: 'Apple Inc.' });
    await waitFor(() => expect(screen.queryByText('Latest earnings')).not.toBeInTheDocument());
    server.use(http.get(api('/earnings/status'), () => HttpResponse.json({ ...DEMO_EARNINGS_STATUS, configured: false, missing: ['sec-contact'] })));
    renderApp('/assets/AAPL?portfolio=all');
    await screen.findAllByRole('heading', { level: 1, name: 'Apple Inc.' });
    expect(screen.queryByText('Latest earnings')).not.toBeInTheDocument();
  });
});

/** Lets the pending query settle inside act, so a link that never appears is really absent. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

describe('SummaryLink in the calendar event dialog', () => {
  it('offers "View summary" when a summary was released around the event date', async () => {
    available();
    renderWithProviders(<SummaryLink symbol="AAPL" date="2026-10-23" />);
    expect(await screen.findByRole('link', { name: 'View summary' })).toHaveAttribute('href', '/earnings/AAPL');
  });

  it('offers nothing for a date far from any summary, or without the feature', async () => {
    available();
    const { unmount } = renderWithProviders(<SummaryLink symbol="AAPL" date="2027-01-30" />);
    await settle();
    expect(screen.queryByRole('link', { name: 'View summary' })).not.toBeInTheDocument();
    unmount();
    server.resetHandlers();
    renderWithProviders(<SummaryLink symbol="AAPL" date="2026-10-23" />);
    await settle();
    expect(screen.queryByRole('link', { name: 'View summary' })).not.toBeInTheDocument();
  });
});
