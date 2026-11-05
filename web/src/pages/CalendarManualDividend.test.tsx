import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { addIsoDays } from '@portfolio/shared';
import { renderWithProviders } from '../test/utils';
import { server } from '../mocks/server';
import { resetDb } from '../mocks/db';
import { api } from '../mocks/utils';
import { localToday } from '../features/calendar/calendarModel';
import { CalendarPage } from './CalendarPage';

const TODAY = localToday();
const EX_DATE = addIsoDays(TODAY, 200);
const PAY_DATE = addIsoDays(TODAY, 210);

const open = () => renderWithProviders(<CalendarPage />, { route: '/calendar?view=list&range=year' });
const events = () => screen.getByRole('region', { name: 'Events' });
/** The event buttons of one day of the list. */
const dayButtons = async (date: string) => {
  const heading = await waitFor(() => {
    const found = events().querySelector<HTMLElement>(`[id="day-${date}"]`);
    expect(found).not.toBeNull();
    return found!;
  });
  return within(heading.closest('section')!).getAllByRole('button');
};

async function fillAndSave(user: ReturnType<typeof userEvent.setup>, fields: { symbol?: string; ex?: string; pay?: string; amount?: string; currency?: string }) {
  const dialog = await screen.findByRole('dialog', { name: /dividend date/i });
  if (fields.symbol !== undefined) await user.selectOptions(within(dialog).getByLabelText('Symbol'), fields.symbol);
  if (fields.ex !== undefined) await user.type(within(dialog).getByLabelText('Ex-dividend date'), fields.ex);
  if (fields.pay !== undefined) await user.type(within(dialog).getByLabelText('Payment date (optional)'), fields.pay);
  if (fields.amount !== undefined) await user.type(within(dialog).getByLabelText('Amount per share (optional)'), fields.amount);
  if (fields.currency !== undefined) {
    await user.clear(within(dialog).getByLabelText('Currency'));
    await user.type(within(dialog).getByLabelText('Currency'), fields.currency);
  }
  await user.click(within(dialog).getByRole('button', { name: 'Save dividend date' }));
  return dialog;
}

describe('Add dividend date (the calendar page)', () => {
  beforeEach(() => resetDb());

  it('adds a declared dividend date of a held symbol, which shows in the calendar as entered by you', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Add dividend date' }));
    await fillAndSave(user, { symbol: 'JNJ', ex: EX_DATE, pay: PAY_DATE, amount: '1.3' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const [ex, ...rest] = await dayButtons(EX_DATE);
    expect(rest).toEqual([]);
    expect(ex).toHaveAccessibleName(/^JNJ, Ex-dividend, confirmed/);
    expect(await dayButtons(PAY_DATE)).toHaveLength(1);
    await user.click(ex!);
    const details = await screen.findByRole('dialog', { name: 'JNJ · Ex-dividend' });
    expect(details).toHaveTextContent('Entered by you');
    expect(details).toHaveTextContent(/Per shareUS\$\s1,30/);
  });

  it('shows an entry without an amount as such, offers edit and delete, and removes it', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Add dividend date' }));
    await fillAndSave(user, { symbol: 'KO', ex: EX_DATE });
    const [ex] = await dayButtons(EX_DATE);
    await user.click(ex!);
    const details = await screen.findByRole('dialog', { name: 'KO · Ex-dividend' });
    expect(details).toHaveTextContent('Per shareNot known yet: you entered no amount');

    await user.click(within(details).getByRole('button', { name: 'Edit' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit dividend date · KO' });
    expect(within(edit).getByLabelText('Symbol')).toBeDisabled();
    expect(within(edit).getByLabelText('Ex-dividend date')).toBeDisabled();
    expect(within(edit).getByLabelText('Amount per share (optional)')).toHaveValue('');
    await user.type(within(edit).getByLabelText('Amount per share (optional)'), '0,5');
    await user.click(within(edit).getByRole('button', { name: 'Save dividend date' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const [edited] = await dayButtons(EX_DATE);
    await user.click(edited!);
    const again = await screen.findByRole('dialog', { name: 'KO · Ex-dividend' });
    await waitFor(() => expect(again).toHaveTextContent(/Per shareUS\$\s0,50/));
    await user.click(within(again).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(events().querySelector(`[id="day-${EX_DATE}"]`)).toBeNull());
  });

  it('checks the form before it asks the backend', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Add dividend date' }));
    const dialog = await fillAndSave(user, {});
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Enter the ex-dividend date');
    await user.type(within(dialog).getByLabelText('Ex-dividend date'), EX_DATE);
    await user.type(within(dialog).getByLabelText('Payment date (optional)'), addIsoDays(EX_DATE, -1));
    await user.click(within(dialog).getByRole('button', { name: 'Save dividend date' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('cannot be before the ex-dividend date');
    await user.clear(within(dialog).getByLabelText('Payment date (optional)'));
    await user.type(within(dialog).getByLabelText('Amount per share (optional)'), 'abc');
    await user.click(within(dialog).getByRole('button', { name: 'Save dividend date' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('positive number');
    await user.clear(within(dialog).getByLabelText('Amount per share (optional)'));
    await user.clear(within(dialog).getByLabelText('Currency'));
    await user.type(within(dialog).getByLabelText('Currency'), 'US');
    await user.click(within(dialog).getByRole('button', { name: 'Save dividend date' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('3-letter code');
  });

  it('takes the currency of the chosen symbol and shows what the backend refuses', async () => {
    const user = userEvent.setup();
    server.use(http.post(api('/calendar/dividends'), () => HttpResponse.json({ error: { code: 'UNPROCESSABLE', message: 'The ex-date must be within 400 days of today' } }, { status: 422 })));
    open();
    await user.click(await screen.findByRole('button', { name: 'Add dividend date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add dividend date' });
    await user.selectOptions(within(dialog).getByLabelText('Symbol'), 'VWRL.AS');
    expect(within(dialog).getByLabelText('Currency')).toHaveValue('EUR');
    await fillAndSave(user, { ex: EX_DATE });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('within 400 days');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows why a delete failed and keeps the entry', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Add dividend date' }));
    await fillAndSave(user, { symbol: 'KO', ex: EX_DATE, amount: '0.5' });
    server.use(http.delete(api('/calendar/dividends/:symbol/:exDate'), () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'There is no such entry' } }, { status: 404 })));
    const [ex] = await dayButtons(EX_DATE);
    await user.click(ex!);
    const details = await screen.findByRole('dialog', { name: 'KO · Ex-dividend' });
    await user.click(within(details).getByRole('button', { name: 'Delete' }));
    expect(await within(details).findByRole('alert')).toHaveTextContent('There is no such entry');
    expect(events().querySelector(`[id="day-${EX_DATE}"]`)).not.toBeNull();
  });
});
