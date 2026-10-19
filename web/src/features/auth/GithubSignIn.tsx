import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { routerBasename } from '../../config';
import { AuthCard, FormMessage } from './AuthCard';
import { useAuth } from './AuthContext';
import { loginUrl } from './githubSession';

/** Everything a signed-out visitor sees in GitHub mode: one way in, a full-page navigation to the Worker's sign-in. */
export function GithubSignIn() {
  const { notice } = useAuth();
  const { pathname, search, hash } = useLocation();
  const href = loginUrl(`${routerBasename() ?? ''}${pathname}${search}${hash}`);

  useEffect(() => {
    document.title = 'Sign in · Portfolio Tracker';
  }, []);

  return (
    <AuthCard title="Sign in" description="This is a private portfolio. Continue with the owner's GitHub account.">
      <div className="space-y-4">
        {notice && <FormMessage kind="notice">{notice}</FormMessage>}
        <a href={href} className="btn-primary w-full">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="8" cy="12" r="3.5" />
            <path d="M11.5 12H21m-3 0v3m-3-3v2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>Sign in with GitHub</span>
        </a>
        <p className="muted text-center text-xs">
          Only the owner&apos;s GitHub account is allowed. If GitHub sends you back to a page saying you do not have access, the account you
          chose is not authorised. Switch to the right GitHub account and try again.
        </p>
      </div>
    </AuthCard>
  );
}

/** The session check failed (network or server error): this is not "signed out", so offer a retry instead of a sign-in. */
export function SessionCheckFailed({ onRetry }: Readonly<{ onRetry: () => void }>) {
  return (
    <AuthCard title="Could not check your sign-in" description="The server did not answer. Your data is safe; check your connection and try again.">
      <button type="button" className="btn-primary w-full" onClick={onRetry}>
        Try again
      </button>
    </AuthCard>
  );
}
