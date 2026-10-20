import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { server } from '../../mocks/server';
import { api as apiPath, errorResponse } from '../../mocks/utils';
import { fakeAuthService, fakeGithubSession, GITHUB_CONFIG, renderAuthApp } from '../../test/auth';
import { createTestQueryClient } from '../../test/utils';
import { useAuth } from './AuthContext';
import { GithubAuthProvider } from './GithubAuthProvider';
import { SESSION_EXPIRED_NOTICE } from './errors';
import { authorizationHeaders, notifyUnauthorized } from './tokenHooks';

const dashboard = () => screen.findByRole('heading', { level: 1, name: 'Dashboard' });
const signInHeading = () => screen.findByRole('heading', { level: 1, name: 'Sign in' });
const signInLink = () => screen.getByRole('link', { name: 'Sign in with GitHub' });

function renderGithub(session = fakeGithubSession(), route = '/') {
  return { session, ...renderAuthApp(fakeAuthService(), { config: GITHUB_CONFIG, githubSession: session, route }) };
}

describe('GitHub mode: session bootstrap', () => {
  it('shows a loading state, never the app, until the session check resolves; asks exactly once', async () => {
    let finish!: (login: string | null) => void;
    const session = fakeGithubSession({ fetchSession: vi.fn(() => new Promise<string | null>((r) => (finish = r))) });
    renderGithub(session);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).not.toBeInTheDocument();
    await act(async () => finish('octo-owner'));
    expect(await dashboard()).toBeInTheDocument();
    expect(session.fetchSession).toHaveBeenCalledTimes(1);
  });

  it('renders the app without a demo banner when the owner is signed in', async () => {
    renderGithub();
    expect(await dashboard()).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Demo mode' })).not.toBeInTheDocument();
    expect(screen.queryByText('Switch to real data')).not.toBeInTheDocument();
  });

  it('shows the error state with a retry when the check fails, then recovers', async () => {
    const user = userEvent.setup();
    const session = fakeGithubSession({ fetchSession: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('octo-owner') });
    renderGithub(session);
    expect(await screen.findByRole('heading', { level: 1, name: 'Could not check your sign-in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in with GitHub' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await dashboard()).toBeInTheDocument();
    expect(session.fetchSession).toHaveBeenCalledTimes(2);
  });

  it('can fail again on retry and stays on the error state', async () => {
    const user = userEvent.setup();
    const session = fakeGithubSession({ fetchSession: vi.fn().mockRejectedValue(new Error('offline')) });
    renderGithub(session);
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(session.fetchSession).toHaveBeenCalledTimes(2);
  });

  it('ignores a check that finishes after the app was closed', async () => {
    let fail!: (err: Error) => void;
    const session = fakeGithubSession({ fetchSession: vi.fn(() => new Promise<string | null>((_, reject) => (fail = reject))) });
    const { unmount } = renderGithub(session);
    unmount();
    await act(async () => fail(new Error('aborted')));
    expect(session.fetchSession.mock.calls[0]![0].aborted).toBe(true);
  });
});

describe('GitHub mode: sign-in screen', () => {
  it('shows an accessible sign-in screen with one primary link, and no app, API calls or Cognito form', async () => {
    const user = userEvent.setup();
    const apiCalls: string[] = [];
    server.events.on('request:start', ({ request }) => void apiCalls.push(new URL(request.url).pathname));
    renderGithub(fakeGithubSession({ fetchSession: vi.fn().mockResolvedValue(null) }));
    expect(await signInHeading()).toBeInTheDocument();
    expect(document.title).toBe('Sign in · Portfolio Tracker');
    expect(screen.getByRole('main')).toContainElement(signInLink());
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/Only the owner/)).toBeInTheDocument();
    expect(screen.queryByText('Demo mode')).not.toBeInTheDocument();
    await user.tab();
    expect(signInLink()).toHaveFocus();
    expect(apiCalls.filter((p) => p.startsWith('/api'))).toEqual([]);
    server.events.removeAllListeners();
  });

  it('links to /auth/login with the current path, query and hash as an encoded returnTo (full-page navigation)', async () => {
    renderGithub(fakeGithubSession({ fetchSession: vi.fn().mockResolvedValue(null) }), '/holdings?scope=a#top');
    await signInHeading();
    const href = signInLink().getAttribute('href');
    expect(href).toBe('/auth/login?returnTo=%2Fholdings%3Fscope%3Da%23top');
    expect(signInLink()).not.toHaveAttribute('target');
  });

  it('guards every route and does not echo unsafe locations into returnTo', async () => {
    renderGithub(fakeGithubSession({ fetchSession: vi.fn().mockResolvedValue(null) }), '/auth/login');
    await signInHeading();
    expect(signInLink()).toHaveAttribute('href', '/auth/login?returnTo=%2F');
  });
});

describe('GitHub mode: account menu and sign-out', () => {
  it('shows the login name and signs out via the server, returning to the sign-in screen', async () => {
    const user = userEvent.setup();
    const { session, queryClient } = renderGithub();
    await dashboard();
    await waitFor(() => expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByText('octo-owner')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await signInHeading()).toBeInTheDocument();
    expect(session.logout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('stays signed in and says so when the server could not end the session', async () => {
    const user = userEvent.setup();
    const session = fakeGithubSession({ logout: vi.fn().mockRejectedValue(new Error('Could not sign out. Check your connection and try again.')) });
    renderGithub(session);
    await dashboard();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out.');
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();

    session.logout.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await signInHeading()).toBeInTheDocument();
  });

  it('shows a generic message when sign-out fails with a non-Error', async () => {
    const user = userEvent.setup();
    renderGithub(fakeGithubSession({ logout: vi.fn().mockRejectedValue('boom') }));
    await dashboard();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out.');
  });

  it('exposes inert password actions: they are not used in this mode', async () => {
    let auth!: ReturnType<typeof useAuth>;
    function Probe() {
      auth = useAuth();
      return null;
    }
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <GithubAuthProvider session={fakeGithubSession()}>
          <Probe />
        </GithubAuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(auth.status).toBe('signedIn'));
    expect(auth).toMatchObject({ enabled: true, provider: 'github', login: 'octo-owner' });
    await expect(auth.signIn('a', 'b')).rejects.toThrow('not used');
    await expect(auth.submitTotp('1')).rejects.toThrow('not used');
  });
});

describe('GitHub mode: Notifications entry of the account menu', () => {
  const available = { available: true, configured: true, publicKey: 'B'.repeat(87), settings: { types: { exDividend: true, declared: true, received: true }, exDividendDaysBefore: 2 }, devices: [], maxDevices: 10 };

  it('offers Notifications when the server can send them and opens the page', async () => {
    const user = userEvent.setup();
    server.use(http.get(apiPath('/notifications'), () => HttpResponse.json(available)));
    renderGithub();
    await dashboard();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(await screen.findByRole('link', { name: 'Notifications' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(document.title).toBe('Notifications · Portfolio Tracker');
  });

  it('hides the entry when the deployment has no push sender (the default API says unavailable)', async () => {
    const user = userEvent.setup();
    renderGithub();
    await dashboard();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Notifications' })).not.toBeInTheDocument());
  });

  it('hides the entry while the state cannot be loaded', async () => {
    const user = userEvent.setup();
    server.use(http.get(apiPath('/notifications'), () => errorResponse(500, 'INTERNAL', 'Boom')));
    renderGithub();
    await dashboard();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Notifications' })).not.toBeInTheDocument();
  });
});

describe('GitHub mode: API calls are authenticated by the cookie alone', () => {
  it('sends same-origin credentials and no Authorization header', async () => {
    let seen: { credentials: string; authorization: string | null } | undefined;
    server.use(
      http.get(apiPath('/portfolios'), ({ request }) => {
        seen = { credentials: request.credentials, authorization: request.headers.get('authorization') };
        return HttpResponse.json({ portfolios: [] });
      }),
    );
    renderGithub();
    await dashboard();
    await api.listPortfolios();
    expect(seen).toEqual({ credentials: 'same-origin', authorization: null });
    await expect(authorizationHeaders()).resolves.toEqual({});
  });

  it('returns to the sign-in screen with a notice (and drops cached data) when the API answers 401', async () => {
    server.use(http.get(apiPath('/portfolio'), () => errorResponse(401, 'UNAUTHORIZED', 'Not signed in')));
    const { queryClient } = renderGithub();
    expect(await signInHeading()).toBeInTheDocument();
    expect(await screen.findByText(SESSION_EXPIRED_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(signInLink()).toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll().filter((q) => q.state.data !== undefined)).toHaveLength(0);
  });

  it('ignores a 401 that arrives when nobody is signed in', async () => {
    renderGithub(fakeGithubSession({ fetchSession: vi.fn().mockResolvedValue(null) }));
    await signInHeading();
    act(() => notifyUnauthorized());
    expect(screen.queryByText(SESSION_EXPIRED_NOTICE)).not.toBeInTheDocument();
    expect(await signInHeading()).toBeInTheDocument();
  });
});
