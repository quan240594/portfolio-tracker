import { ApiError, errorMessage } from '../api/client';
import { isBudgetCode } from '../features/usage/budgetSignal';

const FAILURE_TONE = 'border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/40';
// A pause to stay inside the free plan is expected behaviour, not a failure: calm colours and wording.
const PAUSE_TONE = 'border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/40';

interface Props {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
}

export function ErrorState({ error, onRetry, title = 'Could not load data', className = '' }: Readonly<Props>) {
  const paused = error instanceof ApiError && isBudgetCode(error.code);
  return (
    <div role="alert" className={`flex flex-col items-start gap-3 rounded-xl border p-4 text-sm ${paused ? PAUSE_TONE : FAILURE_TONE} ${className}`}>
      <div>
        <p className={`font-semibold ${paused ? 'text-sky-900 dark:text-sky-100' : 'text-red-800 dark:text-red-200'}`}>{paused ? 'Paused for now' : title}</p>
        <p className={`mt-1 ${paused ? 'text-sky-800 dark:text-sky-200' : 'text-red-700 dark:text-red-300'}`}>{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
