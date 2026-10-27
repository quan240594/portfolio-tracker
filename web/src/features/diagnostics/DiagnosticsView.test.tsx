import type { AlarmDiagnosticsReport } from '@portfolio/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { renderApp, renderWithProviders } from '../../test/utils';
import { DiagnosticsView } from './DiagnosticsView';
import { report, run } from '../../test/diagnostics';

const mocks = vi.hoisted(() => ({ useMocks: false }));
vi.mock('../../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config')>()),
  get USE_MOCKS() {
    return mocks.useMocks;
  },
}));

const serve = (body: AlarmDiagnosticsReport = report()) => server.use(http.get(api('/diagnostics/alarms'), () => HttpResponse.json(body)));

describe('Diagnostics page', () => {
  it('shows the 24-hour summary, the armed alarm and the runs with their time, duration, outcome, retry, jobs and error', async () => {
    serve();
    renderApp('/settings/diagnostics');
    expect(await screen.findByRole('heading', { level: 1, name: 'Diagnostics' })).toBeInTheDocument();
    expect(document.title).toBe('Diagnostics · Portfolio Tracker');

    const summary = await screen.findByRole('region', { name: 'Last 24 hours' });
    const stat = (label: string) => within(summary).getByText(label).nextElementSibling?.textContent;
    expect([stat('Runs'), stat('Completed'), stat('Deferred'), stat('Failed'), stat('No finish'), stat('Retries')]).toEqual(['4', '1', '1', '1', '1', '1']);
    expect(within(summary).getByText(/cut short by the platform/)).toBeInTheDocument();
    expect(within(summary).getByText('20-10-2026, 11:42')).toBeInTheDocument(); // armed for T + 15 min
    expect(within(summary).getByText('Jobs due or waiting:', { exact: false })).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Last 4 alarm runs, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent);
    expect(cells(rows[0]!)).toEqual(['20-10-2026, 12:27schedules: t212-quotes', '–', 'No finish', 'No', '–', '–']);
    expect(cells(rows[1]!)).toEqual(['20-10-2026, 11:57schedules: t212-quotes', '850 ms', 'Failed', 'Retry 2', '–', 'Error: no such table: jobs']);
    expect(cells(rows[2]!)).toEqual(['20-10-2026, 11:42schedules: t212-quotes', '2.4 s', 'Deferred', 'No', 'syncBroker: continued (2 steps, next in 1 min 0 s)', '–']);
    expect(cells(rows[3]!)).toEqual(['20-10-2026, 11:27schedules: t212-quotes', '850 ms', 'Completed', 'No', 'refreshT212Quotes: done', '–']);
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Started', 'Duration', 'Outcome', 'Retry', 'Jobs', 'Error']);
    expect(screen.getByRole('heading', { level: 2, name: 'Alarm changes outside a normal run' })).toBeInTheDocument();
  });

  it('shows the full UTC time of an instant on hover and no warning when every run finished', async () => {
    serve(report({ summary: { ...report().summary, unfinished: 0, failed: 0, retries: 0 }, runs: [run()], arms: [], armed: { alarmAt: null, dueJobs: [], schedules: [] } }));
    renderWithProviders(<DiagnosticsView />);
    expect(await screen.findByRole('table', { name: 'Last 1 alarm runs, newest first' })).toBeInTheDocument();
    expect(screen.queryByText(/cut short by the platform/)).not.toBeInTheDocument();
    expect(screen.getByText(/nothing \(or an alarm is running right now\)/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Alarm changes outside a normal run' })).not.toBeInTheDocument();
    const time = screen.getAllByText('20-10-2026, 11:27')[0]!;
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('title', new Date(run().startedAt).toISOString());
  });

  it('says so when no run is recorded yet', async () => {
    serve(report({ runs: [], arms: [], summary: { ...report().summary, runs: 0, completed: 0, deferred: 0, failed: 0, unfinished: 0, retries: 0 } }));
    renderWithProviders(<DiagnosticsView />);
    expect(await screen.findByRole('heading', { name: 'No alarm run recorded yet' })).toBeInTheDocument();
  });

  it('is not available on a deployment without the endpoint, and in the demo build', async () => {
    renderWithProviders(<DiagnosticsView />);
    expect(await screen.findByRole('heading', { name: 'Diagnostics are not available' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('asks nothing in the demo build', async () => {
    mocks.useMocks = true;
    try {
      let asked = false;
      server.use(
        http.get(api('/diagnostics/alarms'), () => {
          asked = true;
          return HttpResponse.json(report());
        }),
      );
      renderWithProviders(<DiagnosticsView />);
      expect(await screen.findByRole('heading', { name: 'Diagnostics are not available' })).toBeInTheDocument();
      expect(asked).toBe(false);
    } finally {
      mocks.useMocks = false;
    }
  });

  it('shows the loading state, then an error with a retry that recovers', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get(api('/diagnostics/alarms'), () => {
        calls += 1;
        return calls === 1 ? new HttpResponse(null, { status: 500 }) : HttpResponse.json(report());
      }),
    );
    renderWithProviders(<DiagnosticsView />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading diagnostics');
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('refreshes on demand and shows the newer reading', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.get(api('/diagnostics/alarms'), () => {
        calls += 1;
        return HttpResponse.json(report({ runs: calls === 1 ? [run({ id: 1 })] : [run({ id: 2 }), run({ id: 1 })] }));
      }),
    );
    renderWithProviders(<DiagnosticsView />);
    await screen.findByRole('table', { name: 'Last 1 alarm runs, newest first' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('table', { name: 'Last 2 alarm runs, newest first' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });
});

const cardOrder = () => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId);

describe('Diagnostics page layout', () => {
  it('keeps the default card order and puts the customize toggle in the page header', async () => {
    serve();
    renderApp('/settings/diagnostics');
    await screen.findByRole('region', { name: 'Last 24 hours' });
    expect(cardOrder()).toEqual(['price-coverage', 'valuation-report', 'alarm-summary', 'alarm-runs', 'alarm-arms']);
    const actions = document.querySelector<HTMLElement>('[data-page-header-actions]')!;
    expect(within(actions).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('moves the runs above the summary and hides the arms', async () => {
    serve();
    const user = userEvent.setup();
    renderApp('/settings/diagnostics');
    await screen.findByRole('region', { name: 'Last 24 hours' });
    await user.click(screen.getByRole('button', { name: 'Customize layout' }));
    await user.click(screen.getByRole('button', { name: 'Move Alarm runs up' }));
    expect(cardOrder()).toEqual(['price-coverage', 'valuation-report', 'alarm-runs', 'alarm-summary', 'alarm-arms']);

    await user.click(screen.getByRole('button', { name: 'Hide Alarm changes' }));
    expect(screen.queryByRole('heading', { name: 'Alarm changes outside a normal run' })).not.toBeInTheDocument();
  });
});
