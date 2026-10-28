import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp } from '../test/utils';
import { server } from '../mocks/server';
import { getPortfolio } from '../mocks/db';

const cardIds = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId!);
const headerActions = () => document.querySelector<HTMLElement>('[data-page-header-actions]')!;
const serverError = (message: string) => HttpResponse.json({ error: { code: 'INTERNAL', message } }, { status: 500 });

const DEFAULT_ORDER = [
  'kpi-total-value',
  'kpi-day-change',
  'kpi-unrealized',
  'kpi-currency-effect',
  'kpi-total-return',
  'kpi-dividends-received',
  'kpi-realized',
  'kpi-irr',
  'kpi-twr',
  'kpi-yield-ttm',
  'kpi-growth-ttm',
  'kpi-passive-income',
  'kpi-cash',
  'kpi-custom-assets',
  'insights',
  'performance',
  'allocation',
  'top-holdings',
  'calendar',
  'watchlist-widget',
  'movers',
  'total-return-note',
];

async function openDashboard() {
  const user = userEvent.setup();
  renderApp('/');
  await waitFor(() => expect(cardIds()).toEqual(DEFAULT_ORDER));
  await waitFor(() => expect(within(headerActions()).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument());
  return user;
}

describe('Dashboard as a customizable card grid', () => {
  it('keeps the default order and widths, with the period toggle in the header next to the Customize switch', async () => {
    await openDashboard();
    const width = (id: string) => document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!.dataset.width;
    expect(DEFAULT_ORDER.filter((id) => id.startsWith('kpi-')).map(width)).toEqual(Array.from({ length: 14 }, () => 'third'));
    expect([width('insights'), width('performance'), width('allocation'), width('top-holdings'), width('calendar'), width('watchlist-widget'), width('movers'), width('total-return-note')]).toEqual([
      'full',
      'twothirds',
      'third',
      'half',
      'half',
      'full',
      'full',
      'full',
    ]);
    expect(within(headerActions()).getByRole('radiogroup', { name: 'Period' })).toBeInTheDocument();
  });

  it('moves a KPI card and hides another one while the period toggle keeps working', async () => {
    const user = await openDashboard();
    await user.click(within(headerActions()).getByRole('button', { name: 'Customize layout' }));
    await user.click(screen.getByRole('button', { name: 'Move Dividend yield (TTM) up' }));
    expect(cardIds().slice(7, 11)).toEqual(['kpi-irr', 'kpi-yield-ttm', 'kpi-twr', 'kpi-growth-ttm']);
    await user.click(screen.getByRole('button', { name: 'Hide Realized P&L' }));
    expect(screen.queryByRole('region', { name: 'Realized P&L' })).not.toBeInTheDocument();
    expect(cardIds()).not.toContain('kpi-realized');

    await user.click(within(headerActions()).getByRole('radio', { name: 'YTD' }));
    expect(within(headerActions()).getByRole('radio', { name: 'YTD' })).toBeChecked();
    expect(screen.getByRole('region', { name: 'Total return' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(cardIds()).toEqual(DEFAULT_ORDER);
  });

  it('shows a failed summary once, on Total value, and the cards that depend on it step aside', async () => {
    server.use(http.get('/api/portfolio', () => serverError('Summary down')));
    renderApp('/');
    expect(await screen.findByText('Could not load portfolio summary')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Day change' })).not.toBeInTheDocument());
    for (const name of ['Unrealized P&L', 'Currency effect', 'Total return', 'Dividends received', 'Realized P&L', 'Cash', 'Custom assets']) {
      expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
    }
    expect(screen.getAllByText('Could not load portfolio summary')).toHaveLength(1);
  });

  it('replaces the whole grid by the empty state when nothing was ever bought', async () => {
    server.use(http.get('/api/portfolio', () => HttpResponse.json({ ...getPortfolio(), holdingsCount: 0, totalReturn: 0 })));
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'No transactions yet' })).toBeInTheDocument();
    expect(cardIds()).toEqual([]);
    expect(screen.queryByRole('radiogroup', { name: 'Period' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customize layout' })).not.toBeInTheDocument();
  });
});
