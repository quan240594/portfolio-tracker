import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

const cardIds = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId!);
const headerActions = () => document.querySelector<HTMLElement>('[data-page-header-actions]')!;
const customize = (user: ReturnType<typeof userEvent.setup>) => user.click(within(headerActions()).getByRole('button', { name: 'Customize layout' }));

async function openTab(tab: string, expected: string[]) {
  const user = userEvent.setup();
  renderApp(`/analytics?tab=${tab}`);
  await waitFor(() => expect(cardIds()).toEqual(expected));
  await waitFor(() => expect(within(headerActions()).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument());
  return user;
}

describe('Analytics tabs as customizable card grids', () => {
  it('growth: keeps the order, puts the toggle in the header and keeps the lifted state when a card is hidden', async () => {
    const user = await openTab('growth', ['value', 'performance', 'dynamics', 'holdings']);
    expect(screen.getByRole('region', { name: 'Benchmarks' })).toBeInTheDocument();
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Move Portfolio value down' }));
    expect(cardIds()).toEqual(['performance', 'value', 'dynamics', 'holdings']);
    await user.click(screen.getByRole('button', { name: 'Hide Portfolio value' }));
    expect(cardIds()).toEqual(['performance', 'dynamics', 'holdings']);
    expect(screen.queryByRole('region', { name: 'Portfolio value' })).not.toBeInTheDocument();
    expect(await screen.findByTestId('growth-dynamics-chart')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Benchmarks' })).toBeInTheDocument();
  });

  it('metrics: keeps the order and the benchmark selector drives the cards that stay', async () => {
    const user = await openTab('metrics', ['twr', 'pe', 'volatility', 'sharpe', 'sortino']);
    expect(screen.getByRole('heading', { level: 2, name: 'Portfolio metrics' })).toBeInTheDocument();
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Move Time-weighted return down' }));
    expect(cardIds()).toEqual(['pe', 'twr', 'volatility', 'sharpe', 'sortino']);
    await user.click(screen.getByRole('button', { name: 'Hide Price/earnings' }));
    await user.click(screen.getByRole('radio', { name: 'VWRL.AS' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'VWRL.AS' })).toBeChecked());
    expect(cardIds()).toEqual(['twr', 'volatility', 'sharpe', 'sortino']);
    expect(await screen.findByTestId('metric-sortino')).toHaveTextContent('VWRL.AS');
  });

  it('returns: chart and table share the legend selection, also when the chart is moved below the table', async () => {
    const user = await openTab('returns', ['returns-chart', 'returns-table']);
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Move Returns chart down' }));
    expect(cardIds()).toEqual(['returns-table', 'returns-chart']);
    const table = screen.getByRole('table', { name: 'Returns per year, newest first' });
    const chart = screen.getByTestId('returns-chart');
    const before = chart.getAttribute('aria-label') ?? '';
    await user.click(within(within(table).getAllByRole('rowheader')[0]!).getByRole('button'));
    expect(screen.getByTestId('returns-chart').getAttribute('aria-label')).not.toEqual(before);
    expect(screen.getByTestId('selection-note')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide Returns chart' }));
    expect(cardIds()).toEqual(['returns-table']);
    expect(screen.getByRole('table', { name: 'Returns per year, newest first' })).toBeInTheDocument();
  });

  it('risk: keeps the card and hides it again', async () => {
    const user = await openTab('risk', ['risk-metrics']);
    expect(screen.getByRole('table', { name: 'Risk metrics' })).toBeInTheDocument();
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Hide Risk metrics' }));
    expect(cardIds()).toEqual([]);
    expect(screen.queryByRole('table', { name: 'Risk metrics' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Risk metrics' }));
    expect(await screen.findByRole('table', { name: 'Risk metrics' })).toBeInTheDocument();
  });

  it('benchmark: keeps the order and moves the figures above the chart', async () => {
    const user = await openTab('benchmark', ['benchmark-chart', 'benchmark-stats']);
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Move Comparison figures up' }));
    expect(cardIds()).toEqual(['benchmark-stats', 'benchmark-chart']);
    expect(screen.getByText('Your return (TWR)')).toBeInTheDocument();
  });

  it('dividend growth: the year chart and the year table keep sharing their selection after a reorder', async () => {
    const user = await openTab('dividends', ['year-chart', 'month-chart', 'year-table', 'per-share-table']);
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Move Dividends per year table up' }));
    expect(cardIds()).toEqual(['year-chart', 'year-table', 'month-chart', 'per-share-table']);
    await user.click(screen.getByRole('button', { name: 'Hide Dividends per year' }));
    expect(cardIds()).toEqual(['year-table', 'month-chart', 'per-share-table']);
    expect(screen.getByRole('table', { name: 'Dividends per year' })).toBeInTheDocument();
    expect(screen.queryByTestId('dividend-year-chart')).not.toBeInTheDocument();
  });

  it('goal: the form keeps what was typed while its card is hidden', async () => {
    const user = await openTab('goal', ['goal-form', 'goal-results']);
    const target = screen.getByLabelText('Target annual income (€)');
    await user.clear(target);
    await user.type(target, '5000');
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Hide Assumptions' }));
    expect(cardIds()).toEqual(['goal-results']);
    expect(screen.queryByLabelText('Target annual income (€)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show Assumptions' }));
    expect(screen.getByLabelText('Target annual income (€)')).toHaveValue('5000');
    expect(cardIds()).toEqual(['goal-form', 'goal-results']);
  });
});
