import { useId, useRef, useState, useEffect, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { authErrorMessage } from './errors';

export function AuthCard({ title, description, children }: Readonly<{ title: string; description?: string; children: ReactNode }>) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <main className="card w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 text-center">
          <p className="muted text-sm font-medium">Portfolio Tracker</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="muted mt-2 text-sm">{description}</p>}
        </div>
        {children}
      </main>
    </div>
  );
}

export function Field({ label, hint, ...input }: Readonly<{ label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>>) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input id={id} className="input" aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint && (
        <p id={`${id}-hint`} className="muted mt-1 text-xs">
          {hint}
        </p>
      )}
    </div>
  );
}

const MESSAGE_CLASS = {
  error: 'text-sm text-red-600 dark:text-red-400',
  notice: 'text-sm text-emerald-700 dark:text-emerald-400',
} as const;

export const FormMessage = ({ kind, children }: Readonly<{ kind: 'error' | 'notice'; children: ReactNode }>) =>
  kind === 'error' ? (
    <p role="alert" className={MESSAGE_CLASS.error}>
      {children}
    </p>
  ) : (
    <output className={`block ${MESSAGE_CLASS.notice}`}>{children}</output>
  );

export const LinkButton = ({ onClick, children }: Readonly<{ onClick: () => void; children: ReactNode }>) => (
  <button type="button" onClick={onClick} className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
    {children}
  </button>
);

/** Runs `task` on submit with pending/error state; failures are shown as friendly messages. */
export function useSubmit(task: () => Promise<void>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await task();
    } catch (err) {
      if (mounted.current) setError(authErrorMessage(err));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return { pending, error, onSubmit };
}
