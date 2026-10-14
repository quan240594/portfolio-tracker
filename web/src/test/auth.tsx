import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { vi } from 'vitest';
import { routes, ROUTER_FUTURE } from '../App';
import { AuthProvider } from '../features/auth/AuthProvider';
import type { AuthConfig } from '../features/auth/config';
import type { AuthService } from '../features/auth/types';
import { ThemeProvider } from '../theme/ThemeProvider';
import { createTestQueryClient } from './utils';

export const COGNITO_CONFIG: AuthConfig = { mode: 'cognito', userPoolId: 'eu-west-1_Test', clientId: 'client', region: 'eu-west-1' };

type Mocked<T> = { [K in keyof T]: ReturnType<typeof vi.fn> & T[K] };

/** AuthService whose every method is a vi.fn(); defaults model "signed out, nothing configured". */
export function fakeAuthService(overrides: Partial<AuthService> = {}) {
  const service: Mocked<AuthService> = {
    restoreSession: vi.fn().mockResolvedValue(null),
    signIn: vi.fn().mockResolvedValue({ step: 'signedIn', email: 'me@example.com' }),
    completeNewPassword: vi.fn().mockResolvedValue({ step: 'signedIn', email: 'me@example.com' }),
    verifyTotpSetup: vi.fn().mockResolvedValue({ step: 'signedIn', email: 'me@example.com' }),
    submitTotp: vi.fn().mockResolvedValue({ step: 'signedIn', email: 'me@example.com' }),
    requestPasswordReset: vi.fn().mockResolvedValue(undefined),
    confirmPasswordReset: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue('id-token-1'),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as Mocked<AuthService>;
  return service;
}

/** The real route tree behind the real AuthProvider, with a scripted Cognito service. */
export function renderAuthApp(service: AuthService, { route = '/', config = COGNITO_CONFIG }: { route?: string; config?: AuthConfig } = {}) {
  const queryClient = createTestQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [route], future: ROUTER_FUTURE });
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider config={config} loadService={() => Promise.resolve(service)}>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { queryClient, router, ...view };
}
