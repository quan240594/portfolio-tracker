/** Small text under a legend while something is excluded, so a filtered chart is not mistaken for the totals of the headline numbers. */
export function SelectionNote({ className = '' }: Readonly<{ className?: string }>) {
  return (
    <p className={`muted mt-1 text-center text-xs ${className}`} data-testid="selection-note">
      Chart shows the current selection
    </p>
  );
}

/** Replaces the chart when every series or every row is excluded. */
export function NothingSelected({ onShowAll }: Readonly<{ onShowAll: () => void }>) {
  return (
    <p className="muted py-10 text-center text-sm" data-testid="nothing-selected">
      Nothing selected:{' '}
      <button type="button" onClick={onShowAll} className="min-h-6 cursor-pointer rounded font-medium text-brand-700 underline dark:text-brand-400">
        show all
      </button>
    </p>
  );
}
