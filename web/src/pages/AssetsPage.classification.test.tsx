import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CHANGED_ROW, UNHELD_ROW, snowballFile } from '../test/snowballFixtures';
import { renderApp } from '../test/utils';

async function openPage() {
  const user = userEvent.setup();
  renderApp('/assets?portfolio=all');
  const table = await screen.findByRole('table', { name: /^Securities in your portfolio/ });
  return { user, table };
}

describe('AssetsPage: asset classification', () => {
  it('has its own labelled section between the securities and the custom assets', async () => {
    await openPage();
    const section = screen.getByRole('region', { name: 'Asset classification' });
    expect(within(section).getByRole('button', { name: 'Import classification from Snowball' })).toBeInTheDocument();
    expect(section).toHaveTextContent('Your own classification always wins');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Securities in your portfolio')).toBeLessThan(headings.indexOf('Asset classification'));
    expect(headings.indexOf('Asset classification')).toBeLessThan(headings.indexOf('Custom assets'));
  });

  it('imports a file, shows the preview, and the securities table follows the new classification', async () => {
    const { user, table } = await openPage();
    const row = within(table).getByRole('link', { name: 'VWRL.AS' }).closest('tr')!;
    expect(within(row).getByText('Global')).toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: 'Import classification from Snowball' });
    await user.click(trigger);
    const dialog = within(screen.getByRole('dialog', { name: 'Import asset classification' }));
    await user.upload(dialog.getByLabelText('Snowball Holdings CSV'), snowballFile([CHANGED_ROW, UNHELD_ROW]));
    await dialog.findByRole('table', { name: 'Import preview' });
    await user.click(dialog.getByRole('button', { name: 'Confirm import' }));
    expect(await dialog.findByRole('status')).toHaveTextContent('Saved 1 classification.');
    expect(dialog.getByRole('table', { name: 'Import result' })).toHaveTextContent('ZZZZNot matched.');

    await user.click(dialog.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    const updated = within(await screen.findByRole('table', { name: /^Securities in your portfolio/ }));
    expect(await updated.findByText('Invented World Fund')).toBeInTheDocument();
    const vwrl = updated.getByRole('link', { name: 'VWRL.AS' }).closest('tr')!;
    expect(within(vwrl).getByText('Netherlands')).toBeInTheDocument();
    expect(within(vwrl).queryByText('Global')).not.toBeInTheDocument();
  });

  it('cancelling leaves everything as it was', async () => {
    const { user, table } = await openPage();
    await user.click(screen.getByRole('button', { name: 'Import classification from Snowball' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.upload(dialog.getByLabelText('Snowball Holdings CSV'), snowballFile([CHANGED_ROW]));
    await dialog.findByRole('table', { name: 'Import preview' });
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(table).queryByText('Invented World Fund')).not.toBeInTheDocument();
    expect(within(within(table).getByRole('link', { name: 'VWRL.AS' }).closest('tr')!).getByText('Global')).toBeInTheDocument();
  });
});
