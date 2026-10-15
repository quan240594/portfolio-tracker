import { screen, within } from '@testing-library/react';
import { renderApp } from '../../test/utils';

describe('Holdings table links to the asset detail page', () => {
  it('links market securities, keeping the portfolio scope, but not cash or custom assets', async () => {
    renderApp('/holdings?portfolio=default');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: 'VWRL.AS' })).toHaveAttribute('href', '/assets/VWRL.AS?portfolio=default');
    expect(within(table).getByRole('link', { name: 'BTC-EUR' })).toHaveAttribute('href', '/assets/BTC-EUR?portfolio=default');
    expect(within(table).queryByRole('link', { name: /CASH/ })).not.toBeInTheDocument();
    expect(within(table).getAllByText('Custom asset', { selector: 'span.font-semibold' }).length).toBeGreaterThan(0);
  });

  it('links from the mobile cards as well', async () => {
    renderApp('/holdings?portfolio=all');
    const list = await screen.findByRole('list', { name: 'Holdings' });
    expect(within(list).getByRole('link', { name: 'AAPL' })).toHaveAttribute('href', '/assets/AAPL?portfolio=all');
  });
});
