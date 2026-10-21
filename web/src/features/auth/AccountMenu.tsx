import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useNotifications } from '../../api/notificationsHooks';
import { useAlarmDiagnostics } from '../diagnostics/useAlarmDiagnostics';
import { useAuth } from './AuthContext';

/** The Notifications entry: only offered when the server says it can send push notifications (the AWS demo and the mock API cannot). */
function NotificationsLink({ onNavigate }: Readonly<{ onNavigate: () => void }>) {
  const notifications = useNotifications();
  if (!notifications.data?.available) return null;
  return (
    <Link to="/settings/notifications" className="btn-secondary w-full" onClick={onNavigate}>
      Notifications
    </Link>
  );
}

/** The Diagnostics entry: only offered when the server has the alarm diagnostics endpoint (the personal Cloudflare deployment). One run is enough to ask. */
function DiagnosticsLink({ onNavigate }: Readonly<{ onNavigate: () => void }>) {
  const diagnostics = useAlarmDiagnostics(1);
  if (diagnostics.availability !== 'ready') return null;
  return (
    <Link to="/settings/diagnostics" className="btn-secondary w-full" onClick={onNavigate}>
      Diagnostics
    </Link>
  );
}

/** Header account menu (signed-in email or GitHub login + sign out). Renders nothing when auth is off. */
export function AccountMenu() {
  const { enabled, status, email, login, signOut } = useAuth();
  const name = login ?? email;
  const [open, setOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const outside = event instanceof MouseEvent && !rootRef.current?.contains(event.target as Node);
      if (outside || (event instanceof KeyboardEvent && event.key === 'Escape')) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!enabled || status !== 'signedIn') return null;
  const onSignOut = () => {
    setSignOutError(undefined);
    signOut().catch((err: unknown) => setSignOutError(err instanceof Error ? err.message : 'Could not sign out.'));
  };
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Account"
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="card absolute right-0 z-40 mt-2 w-64 space-y-3 p-3 shadow-lg">
          <div>
            <p className="muted text-xs">Signed in as</p>
            <p className="truncate text-sm font-medium" title={name}>
              {name}
            </p>
          </div>
          {signOutError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {signOutError}
            </p>
          )}
          <NotificationsLink onNavigate={() => setOpen(false)} />
          <DiagnosticsLink onNavigate={() => setOpen(false)} />
          <button type="button" className="btn-secondary w-full" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
