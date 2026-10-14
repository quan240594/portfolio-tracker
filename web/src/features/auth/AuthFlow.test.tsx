import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../../api/client';
import { server } from '../../mocks/server';
import { fakeAuthService, renderAuthApp } from '../../test/auth';
import { renderApp } from '../../test/utils';
import { DISABLED_AUTH } from './AuthContext';
import { authorizationHeaders } from './tokenHooks';

const STRONG = 'Str0ng-Passw0rd!';
const dashboard = () => screen.findByRole('heading', { level: 1, name: 'Dashboard' });
const signInHeading = () => screen.findByRole('heading', { name: 'Sign in' });

async function typeInto(user: ReturnType<typeof userEvent.setup>, label: string | RegExp, text: string) {
  await user.type(screen.getByLabelText(label), text);
}

async function submitSignIn(user: ReturnType<typeof userEvent.setup>, email = 'me@example.com', password = 'whatever') {
  await typeInto(user, 'Email', email);
  await typeInto(user, 'Password', password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('sign-in gate', () => {
  it('shows a loading state while the session is restored, then the sign-in form — never the app', async () => {
    let finish!: (email: string | null) => void;
    const service = fakeAuthService({ restoreSession: vi.fn(() => new Promise<string | null>((r) => (finish = r))) });
    renderAuthApp(service);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    await waitFor(() => expect(service.restoreSession).toHaveBeenCalled());
    finish(null);
    expect(await signInHeading()).toBeInTheDocument();
    expect(document.title).toBe('Sign in · Portfolio Tracker');
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  it('guards every route, including the 404 page, and returns to the requested page after sign-in', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService();
    const { router } = renderAuthApp(service, { route: '/holdings' });
    await signInHeading();
    expect(screen.queryByRole('heading', { name: 'Holdings' })).not.toBeInTheDocument();
    await submitSignIn(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Holdings' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/holdings');
  });

  it.each(['/transactions', '/dividends', '/does/not/exist'])('does not render %s for a signed-out visitor', async (route) => {
    renderAuthApp(fakeAuthService(), { route });
    await signInHeading();
    expect(screen.queryByRole('main', { name: /./ })).not.toBeInTheDocument();
    expect(screen.queryByText('Page not found')).not.toBeInTheDocument();
  });

  it('restores a session silently and shows the dashboard with the signed-in email in the account menu', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService({ restoreSession: vi.fn().mockResolvedValue('me@example.com') });
    renderAuthApp(service);
    expect(await dashboard()).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByText('me@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('falls back to the sign-in form when restoring the session fails', async () => {
    renderAuthApp(fakeAuthService({ restoreSession: vi.fn().mockRejectedValue(new Error('offline')) }));
    expect(await signInHeading()).toBeInTheDocument();
  });

  it('refuses to start with an unusable auth configuration (fail closed)', () => {
    renderAuthApp(fakeAuthService(), { config: { mode: 'invalid', reason: 'VITE_COGNITO_CLIENT_ID is required.' } });
    expect(screen.getByRole('heading', { name: 'Sign-in is not configured' })).toBeInTheDocument();
    expect(screen.getByText('VITE_COGNITO_CLIENT_ID is required.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
  });
});

describe('mock/demo mode (auth off)', () => {
  it('loads straight into the dashboard without a sign-in screen or account menu', async () => {
    const service = fakeAuthService();
    renderAuthApp(service, { config: { mode: 'none' } });
    expect(await dashboard()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    expect(service.restoreSession).not.toHaveBeenCalled();
  });

  it('the plain app (no provider) is never gated', async () => {
    renderApp('/');
    expect(await dashboard()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('exposes inert actions when auth is off', async () => {
    await expect(DISABLED_AUTH.signIn('a', 'b')).rejects.toThrow('not enabled');
  });
});

describe('password sign-in', () => {
  it('signs in and lands on the dashboard', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService();
    renderAuthApp(service);
    await signInHeading();
    await submitSignIn(user, 'me@example.com', 'pw');
    expect(await dashboard()).toBeInTheDocument();
    expect(service.signIn).toHaveBeenCalledWith('me@example.com', 'pw');
  });

  it('shows a friendly error for a wrong password and stays on the form', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService({
      signIn: vi.fn().mockRejectedValue(Object.assign(new Error('Incorrect username or password.'), { code: 'NotAuthorizedException' })),
    });
    renderAuthApp(service);
    await signInHeading();
    await submitSignIn(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('uses the typed email when the token carries none', async () => {
    const user = userEvent.setup();
    renderAuthApp(fakeAuthService({ signIn: vi.fn().mockResolvedValue({ step: 'signedIn', email: '' }) }));
    await signInHeading();
    await submitSignIn(user, 'typed@example.com');
    await dashboard();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByText('typed@example.com')).toBeInTheDocument();
  });
});

describe('first login: new password and TOTP enrolment', () => {
  async function toNewPassword(user: ReturnType<typeof userEvent.setup>, service = fakeAuthService()) {
    service.signIn.mockResolvedValue({ step: 'newPassword' });
    const view = renderAuthApp(service);
    await signInHeading();
    await submitSignIn(user, 'me@example.com', 'Temp-Pass1!');
    await screen.findByRole('heading', { name: 'Choose a new password' });
    return { service, ...view };
  }

  it('validates the new password before calling Cognito', async () => {
    const user = userEvent.setup();
    const { service } = await toNewPassword(user);
    await typeInto(user, 'New password', 'short');
    await typeInto(user, 'Confirm new password', 'short');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 12 characters.');

    await user.clear(screen.getByLabelText('New password'));
    await user.clear(screen.getByLabelText('Confirm new password'));
    await typeInto(user, 'New password', STRONG);
    await typeInto(user, 'Confirm new password', `${STRONG}x`);
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The passwords do not match.');
    expect(service.completeNewPassword).not.toHaveBeenCalled();
  });

  it('walks through new password → QR code + manual key → verification code → dashboard', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService();
    service.completeNewPassword.mockResolvedValue({ step: 'totpSetup', secret: 'JBSWY3DPEHPK3PXP' });
    await toNewPassword(user, service);

    await typeInto(user, 'New password', STRONG);
    await typeInto(user, 'Confirm new password', STRONG);
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('heading', { name: 'Set up two-factor authentication' })).toBeInTheDocument();
    expect(service.completeNewPassword).toHaveBeenCalledWith(STRONG);

    const qr = screen.getByRole('img', { name: /QR code/ });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByTestId('totp-secret')).toHaveTextContent('JBSW Y3DP EHPK 3PXP');

    await typeInto(user, '6-digit code', '12');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the 6-digit code');
    expect(service.verifyTotpSetup).not.toHaveBeenCalled();

    service.verifyTotpSetup.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EnableSoftwareTokenMFAException' }));
    await user.clear(screen.getByLabelText('6-digit code'));
    await typeInto(user, '6-digit code', '123 456');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not correct');
    expect(service.verifyTotpSetup).toHaveBeenLastCalledWith('123456');

    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await dashboard()).toBeInTheDocument();
    expect(service.verifyTotpSetup).toHaveBeenCalledTimes(2);
  });

  it('can go straight to TOTP enrolment when the pool asks for it at first sign-in', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService();
    service.signIn.mockResolvedValue({ step: 'totpSetup', secret: 'ABCDEFGH' });
    renderAuthApp(service);
    await signInHeading();
    await submitSignIn(user);
    expect(await screen.findByRole('heading', { name: 'Set up two-factor authentication' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await signInHeading()).toBeInTheDocument();
    expect(service.signOut).toHaveBeenCalled();
  });

  it('shows an expired-session message when the challenge timed out', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService();
    service.completeNewPassword.mockRejectedValue(Object.assign(new Error('Invalid session for the user, session is expired.'), { code: 'NotAuthorizedException' }));
    await toNewPassword(user, service);
    await typeInto(user, 'New password', STRONG);
    await typeInto(user, 'Confirm new password', STRONG);
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('sign-in session expired');
  });
});

describe('TOTP on later sign-ins', () => {
  async function toTotp(user: ReturnType<typeof userEvent.setup>, service = fakeAuthService()) {
    service.signIn.mockResolvedValue({ step: 'totp' });
    renderAuthApp(service);
    await signInHeading();
    await submitSignIn(user);
    await screen.findByRole('heading', { name: 'Two-factor authentication' });
    return service;
  }

  it('asks for the authenticator code, rejects a wrong one and accepts the right one', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService();
    service.submitTotp.mockRejectedValueOnce(Object.assign(new Error('Code mismatch'), { code: 'CodeMismatchException' }));
    await toTotp(user, service);

    await typeInto(user, '6-digit code', '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not correct');

    await user.clear(screen.getByLabelText('6-digit code'));
    await typeInto(user, '6-digit code', '654321');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await dashboard()).toBeInTheDocument();
    expect(service.submitTotp).toHaveBeenLastCalledWith('654321');
  });

  it('lets the user abandon the challenge and sign in again', async () => {
    const user = userEvent.setup();
    const service = await toTotp(userEvent.setup());
    service.signOut.mockRejectedValue(new Error('revoke failed')); // must not block going back
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await signInHeading()).toBeInTheDocument();
  });
});

describe('forgot password', () => {
  it('requests a code, validates the new password and returns to sign-in with a confirmation', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService();
    renderAuthApp(service);
    await signInHeading();
    await typeInto(user, 'Email', 'me@example.com');
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));

    expect(await screen.findByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('me@example.com');
    service.requestPasswordReset.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'LimitExceededException' }));
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');

    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByLabelText('Verification code')).toBeInTheDocument();
    expect(service.requestPasswordReset).toHaveBeenLastCalledWith('me@example.com');

    await typeInto(user, 'Verification code', ' 424242 ');
    await typeInto(user, 'New password', 'weak');
    await typeInto(user, 'Confirm new password', 'weak');
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 12 characters.');
    expect(service.confirmPasswordReset).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('New password'));
    await user.clear(screen.getByLabelText('Confirm new password'));
    await typeInto(user, 'New password', STRONG);
    await typeInto(user, 'Confirm new password', STRONG);
    await user.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await signInHeading()).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Password updated');
    expect(service.confirmPasswordReset).toHaveBeenCalledWith('me@example.com', '424242', STRONG);
  });

  it('can be cancelled and reports an invalid code', async () => {
    const user = userEvent.setup();
    const service = fakeAuthService();
    service.confirmPasswordReset.mockRejectedValue(Object.assign(new Error('x'), { code: 'CodeMismatchException' }));
    renderAuthApp(service);
    await signInHeading();
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await typeInto(user, 'Email', 'me@example.com');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await typeInto(user, 'Verification code', '1');
    await typeInto(user, 'New password', STRONG);
    await typeInto(user, 'Confirm new password', STRONG);
    await user.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not correct');

    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await signInHeading()).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('signed-in session', () => {
  const signedIn = () => fakeAuthService({ restoreSession: vi.fn().mockResolvedValue('me@example.com') });

  it('attaches the ID token as a bearer token to API requests', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get('/api/portfolios', ({ request }) => {
        seen.push(request.headers.get('authorization'));
        return HttpResponse.json({ portfolios: [] });
      }),
    );
    renderAuthApp(signedIn());
    await dashboard();
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.every((h) => h === 'Bearer id-token-1')).toBe(true);
  });

  it('signs out from the account menu: revokes, clears cached data and shows the sign-in form', async () => {
    const user = userEvent.setup();
    const service = signedIn();
    const { queryClient } = renderAuthApp(service);
    await dashboard();
    await waitFor(() => expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(within(screen.getByText('Signed in as').parentElement!.parentElement!).getByRole('button', { name: 'Sign out' }));
    expect(await signInHeading()).toBeInTheDocument();
    expect(service.signOut).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('still signs out locally when revoking the refresh token fails', async () => {
    const user = userEvent.setup();
    const service = signedIn();
    service.signOut.mockRejectedValue(new Error('offline'));
    renderAuthApp(service);
    await dashboard();
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await signInHeading()).toBeInTheDocument();
  });

  it('closes the account menu with Escape and on outside clicks', async () => {
    const user = userEvent.setup();
    renderAuthApp(signedIn());
    await dashboard();
    const button = screen.getByRole('button', { name: 'Account' });
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    await user.click(document.body);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    await user.click(screen.getByText('Signed in as')); // inside the panel: stays open
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('a'); // unrelated keys keep it open
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('signs out automatically with a notice when the API answers 401', async () => {
    server.use(http.get('/api/portfolios', () => HttpResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } }, { status: 401 })));
    const service = signedIn();
    const { queryClient } = renderAuthApp(service);
    expect(await signInHeading()).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session expired. Please sign in again.');
    expect(service.signOut).toHaveBeenCalledTimes(1); // further 401s from in-flight requests do not repeat it
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('turns an unreachable token endpoint into a network error instead of an unauthenticated request', async () => {
    const service = signedIn();
    service.getIdToken.mockRejectedValue(Object.assign(new Error('offline'), { code: 'NetworkError' }));
    renderAuthApp(service);
    await dashboard();
    const call = api.listPortfolios();
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(call).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });

  it('unregisters the API hooks when the provider unmounts', async () => {
    const view = renderAuthApp(signedIn());
    await dashboard();
    expect(await authorizationHeaders()).toEqual({ Authorization: 'Bearer id-token-1' });
    view.unmount();
    expect(await authorizationHeaders()).toEqual({});
  });
});
