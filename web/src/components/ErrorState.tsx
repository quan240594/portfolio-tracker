import { errorMessage } from '../api/client';

interface Props {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
}

export function ErrorState({ error, onRetry, title = 'Could not load data', className = '' }: Readonly<Props>) {
  return (
    <div role="alert" className={`flex flex-col items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900/60 dark:bg-red-950/40 ${className}`}>
      <div>
        <p className="font-semibold text-red-800 dark:text-red-200">{title}</p>
        <p className="mt-1 text-red-700 dark:text-red-300">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
