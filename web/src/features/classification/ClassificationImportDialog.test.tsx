import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ClassificationImportRequest } from '@portfolio/shared';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { CHANGED_ROW, UNCHANGED_ROW, UNHELD_ROW, snowballFile } from '../../test/snowballFixtures';
import { renderWithProviders } from '../../test/utils';
import { ClassificationImportDialog } from './ClassificationImportDialog';

afterEach(() => server.events.removeAllListeners());

function open(onClose = vi.fn()) {
  const user = userEvent.setup();
  const app = renderWithProviders(<ClassificationImportDialog onClose={onClose} />);
  const dialog = screen.getByRole('dialog', { name: 'Import asset classification' });
  return { user, onClose, dialog: within(dialog), ...app };
}

const choose = (user: ReturnType<typeof userEvent.setup>, file: File) => user.upload(screen.getByLabelText('Snowball Holdings CSV'), file);

describe('ClassificationImportDialog', () => {
  it('previews matched, unchanged and unmatched rows, confirms and then shows the result with the unmatched rows still listed', async () => {
    const bodies: ClassificationImportRequest[] = [];
    server.use(
      http.post(api('/classification/import'), async ({ request }) => {
        bodies.push((await request.clone().json()) as ClassificationImportRequest);
      }),
    );
    const { user, dialog } = open();
    const confirm = dialog.getByRole('button', { name: 'Confirm import' });
    expect(confirm).toBeDisabled();
    expect(screen.getByLabelText('Snowball Holdings CSV')).toHaveFocus();

    await choose(user, snowballFile([UNCHANGED_ROW, CHANGED_ROW, UNHELD_ROW]));
    const table = await dialog.findByRole('table', { name: 'Import preview' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('AAPLmatches AAPL by tickerNo change');
    expect(rows[1]).toHaveTextContent('VWRLmatches VWRL.AS by ticker');
    expect(rows[1]).toHaveTextContent('Name: Vanguard FTSE All-World UCITS ETF (Dist) → Invented World Fund');
    expect(rows[1]).toHaveTextContent('Country: Global → Netherlands');
    expect(rows[2]).toHaveTextContent('ZZZZNot matched. Not one of your holdings');
    expect(within(dialog.getByLabelText('Summary')).getByText('With changes').nextElementSibling).toHaveTextContent('1');
    expect(dialog.getByText(/Nothing is saved until you confirm/)).toBeInTheDocument();
    expect(bodies.at(0)).toMatchObject({ dryRun: true });
    expect(confirm).toBeEnabled();

    await user.click(confirm);
    expect(await dialog.findByRole('status')).toHaveTextContent('Saved 2 classifications.');
    expect(dialog.getByRole('status')).toHaveTextContent('1 row was not matched and left out');
    expect(dialog.getByRole('table', { name: 'Import result' })).toHaveTextContent('ZZZZNot matched. Not one of your holdings');
    expect(dialog.queryByRole('button', { name: 'Confirm import' })).not.toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(bodies.at(-1)).toMatchObject({ dryRun: false });
    expect(bodies.at(-1)?.rows.map((r) => r.ticker)).toEqual(['AAPL', 'VWRL', 'ZZZZ']);
  });

  it('keeps Confirm disabled when no matched row changes anything', async () => {
    const { user, dialog } = open();
    await choose(user, snowballFile([UNCHANGED_ROW, UNHELD_ROW]));
    await dialog.findByRole('table', { name: 'Import preview' });
    expect(dialog.getByText(/No matched row changes anything/)).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
  });

  it('shows the notes of the parser next to the preview', async () => {
    const { user, dialog } = open();
    await choose(user, snowballFile([CHANGED_ROW, { holding: 'ODD', name: 'Odd', category: 'Whatever' }]));
    const notes = await dialog.findByRole('region', { name: 'Notes on the file' });
    expect(notes).toHaveTextContent('Line 3: Category "Whatever" is not a known asset kind');
  });

  it('uses the singular for one change and for one saved classification', async () => {
    const { user, dialog } = open();
    await choose(user, snowballFile([CHANGED_ROW]));
    await dialog.findByRole('table', { name: 'Import preview' });
    expect(dialog.getByText(/1 holding changes\./)).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Confirm import' }));
    expect(await dialog.findByRole('status')).toHaveTextContent('Saved 1 classification.');
    expect(dialog.getByRole('status')).not.toHaveTextContent('not matched');
  });

  it('refuses a file that is not a holdings export without calling the API', async () => {
    const requests: string[] = [];
    server.events.on('request:start', ({ request }) => requests.push(new URL(request.url).pathname));
    const { user, dialog } = open();
    await choose(user, new File(['date,type,symbol\n2024-01-01,BUY,AAPL'], 'transactions.csv', { type: 'text/csv' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Not a Snowball holdings export');
    expect(requests).toEqual([]);
    expect(dialog.getByRole('button', { name: 'Confirm import' })).toBeDisabled();
  });

  it('refuses a file over the size limit', async () => {
    const { user, dialog } = open();
    const file = snowballFile([CHANGED_ROW]);
    Object.defineProperty(file, 'size', { value: 1_000_001 });
    await choose(user, file);
    expect(await dialog.findByRole('alert')).toHaveTextContent('The file is larger than 1 MB');
  });

  it('reports a refused preview and lets the owner choose another file', async () => {
    server.use(http.post(api('/classification/import'), () => HttpResponse.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } }, { status: 413 }), { once: true }));
    const { user, dialog } = open();
    await choose(user, snowballFile([CHANGED_ROW]));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Request body too large');
    await choose(user, snowballFile([CHANGED_ROW], 'again.csv'));
    await dialog.findByRole('table', { name: 'Import preview' });
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the preview and says so when saving fails, and can then be confirmed again', async () => {
    const { user, dialog } = open();
    await choose(user, snowballFile([CHANGED_ROW]));
    await dialog.findByRole('table', { name: 'Import preview' });
    server.use(http.post(api('/classification/import'), () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Could not save' } }, { status: 500 }), { once: true }));
    await user.click(dialog.getByRole('button', { name: 'Confirm import' }));
    expect(await dialog.findByRole('alert')).toHaveTextContent('Could not save');
    expect(dialog.getByRole('table', { name: 'Import preview' })).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Confirm import' }));
    expect(await dialog.findByRole('status')).toHaveTextContent('Saved 1 classification.');
  });

  it('only shows the answer for the file chosen last', async () => {
    let release: () => void = () => undefined;
    let asked = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(
        api('/classification/import'),
        async () => {
          asked = true;
          await gate;
          return HttpResponse.json({ dryRun: true, matched: [], unmatched: [{ index: 0, ticker: 'STALE', reason: 'not-held' }], applied: 0 });
        },
        { once: true },
      ),
    );
    const { user, dialog } = open();
    await choose(user, snowballFile([UNHELD_ROW], 'first.csv'));
    await waitFor(() => expect(asked).toBe(true));
    expect(dialog.getByText('Reading first.csv…')).toBeInTheDocument();
    await choose(user, snowballFile([CHANGED_ROW], 'second.csv'));
    const table = await dialog.findByRole('table', { name: 'Import preview' });
    release();
    await waitFor(() => expect(dialog.getByText(/Preview of second.csv/)).toBeInTheDocument());
    expect(table).toHaveTextContent('VWRL');
    expect(dialog.queryByText('STALE')).not.toBeInTheDocument();
  });

  it('ignores the failure of an older file once a newer one was chosen', async () => {
    let release: () => void = () => undefined;
    let asked = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(
        api('/classification/import'),
        async () => {
          asked = true;
          await gate;
          return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Old failure' } }, { status: 500 });
        },
        { once: true },
      ),
    );
    const { user, dialog } = open();
    await choose(user, snowballFile([UNHELD_ROW], 'first.csv'));
    await waitFor(() => expect(asked).toBe(true));
    await choose(user, snowballFile([CHANGED_ROW], 'second.csv'));
    await dialog.findByRole('table', { name: 'Import preview' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
    expect(dialog.getByText(/Preview of second.csv/)).toBeInTheDocument();
  });

  it('ignores the parse result of an older file once a newer one was chosen', async () => {
    let release: () => void = () => undefined;
    const slow = new File(['x'], 'slow.csv', { type: 'text/csv' });
    vi.spyOn(slow, 'arrayBuffer').mockImplementation(() => new Promise<ArrayBuffer>((resolve) => (release = () => resolve(new TextEncoder().encode('not a holdings export').buffer))));
    const { user, dialog } = open();
    await choose(user, slow);
    expect(dialog.getByText('Reading slow.csv…')).toBeInTheDocument();
    await choose(user, snowballFile([CHANGED_ROW], 'second.csv'));
    await dialog.findByRole('table', { name: 'Import preview' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument();
    expect(dialog.getByText(/Preview of second.csv/)).toBeInTheDocument();
  });

  it('ignores an empty file selection', async () => {
    const { user, dialog } = open();
    await choose(user, snowballFile([CHANGED_ROW]));
    await dialog.findByRole('table', { name: 'Import preview' });
    await user.upload(screen.getByLabelText('Snowball Holdings CSV'), []);
    expect(dialog.getByRole('table', { name: 'Import preview' })).toBeInTheDocument();
  });

  it('closes with Cancel, with the close button and with Escape', async () => {
    const first = open();
    await first.user.click(first.dialog.getByRole('button', { name: 'Cancel' }));
    expect(first.onClose).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = open();
    await second.user.click(second.dialog.getByRole('button', { name: 'Close dialog' }));
    expect(second.onClose).toHaveBeenCalledTimes(1);
    await second.user.keyboard('{Escape}');
    expect(second.onClose).toHaveBeenCalledTimes(2);
  });

  it('labels its controls and describes the dialog', () => {
    const { dialog } = open();
    expect(dialog.getByLabelText('Snowball Holdings CSV')).toHaveAttribute('accept', '.csv,text/csv');
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(/read in your browser/);
  });
});
