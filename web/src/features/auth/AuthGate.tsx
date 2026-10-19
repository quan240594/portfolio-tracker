import { lazy, Suspense, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { GithubSignIn, SessionCheckFailed } from './GithubSignIn';

const AuthScreen = lazy(() => import('./AuthScreen'));

function FullPageMessage({ title, children }: Readonly<{ title?: string; children: ReactNode }>) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 px-4 text-center">
      {title && <h1 className="text-xl font-semibold">{title}</h1>}
      <p className="muted text-sm">{children}</p>
    </main>
  );
}

/** Guards every route: renders the app only for a signed-in user (or when auth is off, e.g. the demo). */
export function AuthGate({ children }: Readonly<{ children: ReactNode }>) {
  const { enabled, status, configError, provider, retry } = useAuth();
  if (!enabled) return <>{children}</>;
  if (configError) return <FullPageMessage title="Sign-in is not configured">{configError}</FullPageMessage>;
  if (status === 'loading') return <FullPageMessage>Loading…</FullPageMessage>;
  if (status === 'error') return <SessionCheckFailed onRetry={retry} />;
  if (status === 'signedOut' && provider === 'github') return <GithubSignIn />;
  if (status === 'signedOut') {
    return (
      <Suspense fallback={<FullPageMessage>Loading…</FullPageMessage>}>
        <AuthScreen />
      </Suspense>
    );
  }
  return <>{children}</>;
}
