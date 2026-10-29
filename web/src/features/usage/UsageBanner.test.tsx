import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { api as apiClient } from '../../api/client';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { renderWithProviders } from '../../test/utils';
import { BLOCKED_SNAPSHOT, budgetExhausted, budgetUnavailable, OK_SNAPSHOT, serveUsage, usageSnapshot, WARN_SNAPSHOT } from '../../test/usage';
import { resetBudgetNotice } from './budgetSignal';
import { UsageBanner } from './UsageBanner';
import { USAGE_QUERY_KEY } from './useUsage';
import { localWeekdayTime } from '../../test/localTime';

const local = localWeekdayTime;
const banner = () => screen.findByRole('complementary', { name: 'Free-plan usage' });

/** Lets a request run (and its notice state update) inside act. */
const settle = (request: Promise<unknown>) => act(async () => void (await request.catch(() => undefined)));

afterEach(() => act(() => resetBudgetNotice()));

describe('UsageBanner', () => {
  it('shows nothing while the usage is fine, unknown or not exposed', async () => {
    serveUsage(OK_SNAPSHOT);
    const { container, queryClient } = renderWithProviders(<UsageBanner />);
    await waitFor(() => expect(queryClient.getQueryState(USAGE_QUERY_KEY)?.status).toBe('success'));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing when the backend has no /usage', async () => {
    const { container, queryClient } = renderWithProviders(<UsageBanner />);
    await waitFor(() => expect(queryClient.getQueryState(USAGE_QUERY_KEY)?.status).toBe('success'));
    expect(container).toBeEmptyDOMElement();
  });

  it('warns about the high metrics with the pause policy, the reset time and a Dismiss button', async () => {
    serveUsage(WARN_SNAPSHOT);
    renderWithProviders(<UsageBanner />);
    const note = await banner();
    expect(note).toHaveTextContent('Free-plan usage is getting high (Worker requests 61%, Database rows read 73%).');
    expect(note).toHaveTextContent(`At 80 % of any cap the app pauses new work until the reset at ${local('2026-10-20T00:00:00Z')}.`);
    expect(note.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    expect(within(note).getByRole('status')).toBeInTheDocument();
  });

  it('is dismissible for the session and stays dismissed after a reload, but not on a new UTC day', async () => {
    serveUsage(WARN_SNAPSHOT);
    const first = renderWithProviders(<UsageBanner />);
    await banner();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    first.unmount();

    const second = renderWithProviders(<UsageBanner />);
    await waitFor(() => expect(second.queryClient.getQueryState(USAGE_QUERY_KEY)?.status).toBe('success'));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();

    act(() => second.queryClient.setQueryData(USAGE_QUERY_KEY, { ...WARN_SNAPSHOT, day: '2026-10-20' }));
    expect(await banner()).toBeInTheDocument();
  });

  it('reappears when the state worsened in between (warn, then paused or ok, then warn again)', async () => {
    serveUsage(WARN_SNAPSHOT);
    const { queryClient } = renderWithProviders(<UsageBanner />);
    await banner();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));

    act(() => queryClient.setQueryData(USAGE_QUERY_KEY, BLOCKED_SNAPSHOT));
    expect(await banner()).toHaveTextContent('Paused to stay inside the free plan');
    act(() => queryClient.setQueryData(USAGE_QUERY_KEY, WARN_SNAPSHOT));
    expect(await banner()).toHaveTextContent('Free-plan usage is getting high');
  });

  it('keeps working when session storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    serveUsage(WARN_SNAPSHOT);
    renderWithProviders(<UsageBanner />);
    await banner();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('shows a calm, persistent notice with the reset time when usage is at the block threshold', async () => {
    serveUsage(BLOCKED_SNAPSHOT);
    renderWithProviders(<UsageBanner />);
    const note = await banner();
    expect(note).toHaveTextContent(`Paused to stay inside the free plan, resumes at ${local('2026-10-20T00:00:00Z')}.`);
    expect(within(note).queryByRole('button')).not.toBeInTheDocument();
  });

  it('explains that waiting does not help when only the stored data is at its cap', async () => {
    serveUsage(usageSnapshot({ storageBytes: 85 }));
    renderWithProviders(<UsageBanner />);
    const note = await banner();
    expect(note).toHaveTextContent('the stored data is at its cap');
    expect(note).not.toHaveTextContent('resumes at');
  });

  it('shows the pause from a 429 BUDGET_EXHAUSTED answer even without a usage endpoint, using Retry-After', async () => {
    const before = Date.now();
    renderWithProviders(<UsageBanner />);
    server.use(http.get('/api/holdings', () => budgetExhausted('7200')));
    await act(async () => {
      await expect(apiClient.getHoldings('all')).rejects.toMatchObject({ status: 429, code: 'BUDGET_EXHAUSTED' });
    });
    const note = await banner();
    expect(note).toHaveTextContent(/^Paused to stay inside the free plan, resumes at \S+ \d{2}:\d{2}\.$/);
    // the pause is "now + Retry-After" at the moment the answer arrives: on a slow runner the minute can roll over meanwhile
    const after = Date.now();
    const minutes = Math.ceil((after - before) / 60_000) + 1;
    const accepted = Array.from({ length: minutes }, (_, i) => local(new Date(before + i * 60_000 + 7_200_000).toISOString()));
    expect(accepted.some((expected) => note.textContent?.includes(expected))).toBe(true);
    expect(within(note).queryByRole('button')).not.toBeInTheDocument();
  });

  it('clears the 429 notice once a request succeeds again', async () => {
    renderWithProviders(<UsageBanner />);
    server.use(http.get('/api/holdings', () => budgetExhausted()));
    await settle(apiClient.getHoldings('all'));
    await banner();
    server.resetHandlers();
    await settle(apiClient.getHoldings('all'));
    await waitFor(() => expect(screen.queryByRole('complementary')).not.toBeInTheDocument());
  });

  it('gives a 503 BUDGET_UNAVAILABLE answer its own short message', async () => {
    renderWithProviders(<UsageBanner />);
    server.use(http.delete(api('/transactions/x'), () => budgetUnavailable()));
    await act(async () => {
      await expect(apiClient.deleteTransaction('x')).rejects.toMatchObject({ status: 503, code: 'BUDGET_UNAVAILABLE' });
    });
    const note = await banner();
    expect(note).toHaveTextContent('Usage could not be checked, so changes are paused for a moment. Try again shortly.');
    expect(note).not.toHaveTextContent('resumes at');
  });

  it('prefers the pause notice of a 429 over a plain warning', async () => {
    serveUsage(WARN_SNAPSHOT);
    renderWithProviders(<UsageBanner />);
    await banner();
    server.use(http.get('/api/holdings', () => budgetExhausted('60')));
    await settle(apiClient.getHoldings('all'));
    await waitFor(() => expect(screen.getByRole('complementary')).toHaveTextContent('Paused to stay inside the free plan'));
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });
});
