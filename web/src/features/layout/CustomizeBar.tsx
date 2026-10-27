import type { SaveState } from './useCardLayout';

export interface HiddenCardItem {
  id: string;
  title: string;
}

interface Props {
  editing: boolean;
  onToggle: () => void;
  /** Whether the shown layout is still the page's default one (nothing to reset). */
  isDefault: boolean;
  onReset: () => void;
  hidden: readonly HiddenCardItem[];
  onShow: (id: string) => void;
  isDesktop: boolean;
  saveState: SaveState;
  saveError: string | null;
  onRetry: () => void;
}

/** The "Customize" switch of a page and, while editing, what is not on a card: reset, the hidden cards and the save state. */
export function CustomizeBar({ editing, onToggle, isDefault, onReset, hidden, onShow, isDesktop, saveState, saveError, onRetry }: Readonly<Props>) {
  return (
    <div className="mb-3 flex flex-col gap-2" data-testid="customize-bar">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {editing && (
          <>
            <span className="muted mr-auto text-xs">{isDesktop ? 'Editing the layout for wide screens' : 'Editing the layout for narrow screens'}</span>
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={onReset} disabled={isDefault}>
              Reset to default
            </button>
          </>
        )}
        <button type="button" className={`${editing ? 'btn-primary' : 'btn-secondary'} px-2.5 py-1 text-xs`} aria-pressed={editing} onClick={onToggle}>
          {editing ? 'Done' : 'Customize layout'}
        </button>
      </div>
      {editing && saveState === 'saving' && <p className="muted text-xs">Saving…</p>}
      {editing && saveState === 'error' && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-red-700 dark:text-red-300" role="alert">
          <span>Could not save the layout{saveError ? `: ${saveError}` : ''}.</span>
          <button type="button" className="underline" onClick={onRetry}>
            Try again
          </button>
        </p>
      )}
      {editing && hidden.length > 0 && (
        <section className="card p-3" aria-label="Hidden cards">
          <h3 className="muted mb-2 text-xs font-medium tracking-wide uppercase">Hidden cards</h3>
          <ul className="flex flex-wrap gap-2">
            {hidden.map((card) => (
              <li key={card.id}>
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => onShow(card.id)} aria-label={`Show ${card.title}`}>
                  <span aria-hidden="true">+ </span>
                  <span>{card.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
