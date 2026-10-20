import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ClassificationFields, ClassificationInstrument } from '@portfolio/shared';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { renderWithProviders } from '../../test/utils';
import { EditClassificationDialog } from './EditClassificationDialog';
import { NOTHING_TO_SAVE } from './classificationForm';

const AAPL: ClassificationInstrument = {
  symbol: 'AAPL',
  effective: { name: 'Apple Inc.', assetClass: 'STOCK', sector: 'Technology', country: 'United States' },
  base: { name: 'Apple Inc.', assetClass: 'STOCK', sector: 'Technology', country: 'United States' },
  source: 'provider',
  isin: 'US0378331005',
  currency: 'USD',
  override: null,
  held: true,
  updatedAt: null,
};

const OVERRIDDEN: ClassificationInstrument = {
  ...AAPL,
  effective: { ...AAPL.effective, sector: 'Invented Sector', assetClass: 'COMMODITY' },
  override: { sector: 'Invented Sector', assetClass: 'COMMODITY' },
};

const serverError = (message: string) => HttpResponse.json({ error: { code: 'INTERNAL', message } }, { status: 500 });

function open(instrument: ClassificationInstrument, onClose = vi.fn()) {
  const user = userEvent.setup();
  renderWithProviders(<EditClassificationDialog instrument={instrument} onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { name: 'Edit classification of AAPL' });
  return { user, onClose, dialog: within(dialog) };
}

/** Records the body of every PUT and lets the request fall through to the demo API. */
function recordPuts() {
  const puts: { path: string; body: ClassificationFields }[] = [];
  server.use(
    http.put(api('/classification/:symbol'), async ({ request }) => {
      puts.push({ path: new URL(request.url).pathname, body: (await request.clone().json()) as ClassificationFields });
    }),
  );
  return puts;
}

describe('EditClassificationDialog', () => {
  it('is prefilled with the effective values and shows the automatic value and its source next to every field', () => {
    const { dialog } = open(OVERRIDDEN);
    expect(dialog.getByLabelText('Name')).toHaveValue('Apple Inc.');
    expect(dialog.getByLabelText('Asset class')).toHaveValue('COMMODITY');
    expect(dialog.getByLabelText('Sector')).toHaveValue('Invented Sector');
    expect(dialog.getByLabelText('Country')).toHaveValue('United States');
    expect(dialog.getByLabelText('Name')).toHaveAccessibleDescription('Provider value: Apple Inc.');
    expect(dialog.getByLabelText('Asset class')).toHaveAccessibleDescription('Provider value: Stock');
    expect(dialog.getByLabelText('Sector')).toHaveAccessibleDescription('Provider value: Technology');
    expect(dialog.getByLabelText('Country')).toHaveAccessibleDescription('Provider value: United States');
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/come from a market-data provider/);
    expect(within(dialog.getByLabelText('Asset class')).getAllByRole('option').map((o) => o.textContent)).toContain('Commodity');
    expect(dialog.getByLabelText('Name')).toHaveFocus();
  });

  it('names the Trading 212 source, and says "not set" for a field the profile has no value for', () => {
    const { dialog } = open({ ...AAPL, source: 'trading212', base: { ...AAPL.base, sector: null, country: null }, effective: { ...AAPL.effective, sector: null, country: null } });
    expect(dialog.getByLabelText('Sector')).toHaveValue('');
    expect(dialog.getByLabelText('Sector')).toHaveAccessibleDescription('Trading 212 value: not set');
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/come from Trading 212/);
  });

  it.each([
    ['minimal', 'Value derived from the ticker: Apple Inc.'],
    ['none', 'Automatic value: Apple Inc.'],
  ] as const)('labels the automatic value of a %s source', (source, hint) => {
    const { dialog } = open({ ...AAPL, source });
    expect(dialog.getByLabelText('Name')).toHaveAccessibleDescription(hint);
  });

  it('saves only the fields that differ from the automatic values and closes', async () => {
    const puts = recordPuts();
    const { user, dialog, onClose } = open(AAPL);
    await user.clear(dialog.getByLabelText('Sector'));
    await user.type(dialog.getByLabelText('Sector'), '  Invented Sector ');
    await user.selectOptions(dialog.getByLabelText('Asset class'), 'COMMODITY');
    await user.click(dialog.getByRole('button', { name: 'Save classification' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(puts).toEqual([{ path: '/api/classification/AAPL', body: { assetClass: 'COMMODITY', sector: 'Invented Sector' } }]);
  });

  it('keeps an existing override that the owner leaves as it is, and drops one typed back to the automatic value', async () => {
    const puts = recordPuts();
    const { user, dialog } = open(OVERRIDDEN);
    await user.clear(dialog.getByLabelText('Country'));
    await user.type(dialog.getByLabelText('Country'), 'Invented Land');
    await user.click(dialog.getByRole('button', { name: 'Save classification' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toEqual({ assetClass: 'COMMODITY', sector: 'Invented Sector', country: 'Invented Land' });

    await user.clear(dialog.getByLabelText('Sector'));
    await user.type(dialog.getByLabelText('Sector'), 'Technology');
    await user.click(dialog.getByRole('button', { name: 'Save classification' }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]!.body).toEqual({ assetClass: 'COMMODITY', country: 'Invented Land' });
  });

  it('asks for a change instead of sending an empty override', async () => {
    const puts = recordPuts();
    const { user, dialog, onClose } = open(AAPL);
    await user.click(dialog.getByRole('button', { name: 'Save classification' }));
    expect(dialog.getByRole('alert')).toHaveTextContent(NOTHING_TO_SAVE);
    expect(puts).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses values the API would refuse, naming the field', async () => {
    const puts = recordPuts();
    const { user, dialog } = open(AAPL);
    fireEvent.change(dialog.getByLabelText('Sector'), { target: { value: 'x'.repeat(61) } });
    await user.click(dialog.getByRole('button', { name: 'Save classification' }));
    expect(dialog.getByRole('alert')).toHaveTextContent(/^Sector: /);
    expect(puts).toEqual([]);
    expect(dialog.getByLabelText('Name')).toHaveAttribute('maxlength', '120');
    expect(dialog.getByLabelText('Sector')).toHaveAttribute('maxlength', '60');
    expect(dialog.getByLabelText('Country')).toHaveAttribute('maxlength', '60');
  });

  it('shows the error of a refused save and stays open', async () => {
    server.use(http.put(api('/classification/:symbol'), () => serverError('Could not save'), { once: true }));
    const { user, dialog, onClose } = open(AAPL);
    await user.type(dialog.getByLabelText('Sector'), 'x');
    await user.click(dialog.getByRole('button', { name: 'Save classification' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Could not save');
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.getByRole('button', { name: 'Save classification' })).toBeEnabled();
  });

  it('disables the buttons while resetting', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.delete(api('/classification/:symbol'), async () => {
        await gate;
      }),
    );
    const { user, dialog, onClose } = open(OVERRIDDEN);
    await user.click(dialog.getByRole('button', { name: 'Reset to automatic' }));
    expect(await dialog.findByRole('button', { name: 'Resetting…' })).toBeDisabled();
    expect(dialog.getByRole('button', { name: 'Save classification' })).toBeDisabled();
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('disables the buttons while saving', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.put(api('/classification/:symbol'), async () => {
        await gate;
      }),
    );
    const { user, dialog, onClose } = open(OVERRIDDEN);
    await user.type(dialog.getByLabelText('Name'), ' Group');
    await user.click(dialog.getByRole('button', { name: 'Save classification' }));
    expect(await dialog.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(dialog.getByRole('button', { name: 'Reset to automatic' })).toBeDisabled();
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('offers no reset while the owner has no override', async () => {
    const { user, dialog, onClose } = open(AAPL);
    expect(dialog.queryByRole('button', { name: 'Reset to automatic' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers "Reset to automatic" when an override exists, and removes the override', async () => {
    const deletes: string[] = [];
    server.use(
      http.delete(api('/classification/:symbol'), ({ request }) => {
        deletes.push(new URL(request.url).pathname);
      }),
    );
    const { user, dialog, onClose } = open(OVERRIDDEN);
    await user.click(dialog.getByRole('button', { name: 'Reset to automatic' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(deletes).toEqual(['/api/classification/AAPL']);
  });

  it('shows the error of a refused reset and stays open', async () => {
    server.use(http.delete(api('/classification/:symbol'), () => serverError('Could not reset'), { once: true }));
    const { user, dialog, onClose } = open(OVERRIDDEN);
    await user.click(dialog.getByRole('button', { name: 'Reset to automatic' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Could not reset');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes with Cancel, the close button and Escape without sending anything', async () => {
    const puts = recordPuts();
    const { user, dialog, onClose } = open(AAPL);
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await user.click(dialog.getByRole('button', { name: 'Close dialog' }));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(puts).toEqual([]);
  });
});
