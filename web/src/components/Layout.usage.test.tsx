import { act, screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { server } from '../mocks/server';
import { renderApp } from '../test/utils';
import { BLOCKED_SNAPSHOT, budgetExhausted, OK_SNAPSHOT, serveUsage, WARN_SNAPSHOT } from '../test/usage';
import { resetBudgetNotice } from '../features/usage/budgetSignal';
import { USAGE_QUERY_KEY } from '../features/usage/useUsage';

afterEach(() => act(() => resetBudgetNotice()));

describe('Layout with the usage indicator', () => {
  it('shows the chip in the header, after the other controls', async () => {
    serveUsage(OK_SNAPSHOT);
    renderApp('/');
    const header = screen.getByRole('banner');
    const chip = await within(header).findByRole('button', { name: 'Usage OK' });
    const theme = within(header).getByRole('button', { name: 'Dark mode' });
    expect(theme.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Free-plan usage' })).not.toBeInTheDocument();
  });

  it('shows neither chip nor banner when the backend has no /usage (the AWS deployment)', async () => {
    const { queryClient } = renderApp('/');
    await waitFor(() => expect(queryClient.getQueryState(USAGE_QUERY_KEY)?.status).toBe('success'));
    expect(queryClient.getQueryData(USAGE_QUERY_KEY)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Usage|^Paused$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Free-plan usage' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('puts the warning banner between the header and the page, not inside the sticky unit', async () => {
    serveUsage(WARN_SNAPSHOT);
    renderApp('/');
    const note = await screen.findByRole('complementary', { name: 'Free-plan usage' });
    expect(screen.getByRole('banner').compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('banner').parentElement).not.toContainElement(note);
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('shows a persistent calm notice and a "Paused" chip when usage is blocked', async () => {
    serveUsage(BLOCKED_SNAPSHOT);
    renderApp('/');
    expect(await screen.findByRole('button', { name: 'Paused' })).toBeInTheDocument();
    expect(await screen.findByRole('complementary', { name: 'Free-plan usage' })).toHaveTextContent('Paused to stay inside the free plan, resumes at');
  });

  it('shows a calm "paused" message instead of a generic failure when a page request is answered with 429', async () => {
    // Like the real guard: everything but /usage is refused.
    server.use(http.all(/\/api\/(?!usage)/, () => budgetExhausted('3600')));
    renderApp('/holdings');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Paused for now');
    expect(alert).toHaveTextContent('Paused to stay inside the free plan, resumes at');
    expect(alert).not.toHaveTextContent('Could not load data');
    expect(await screen.findByRole('complementary', { name: 'Free-plan usage' })).toHaveTextContent('Paused to stay inside the free plan, resumes at');
  });
});
