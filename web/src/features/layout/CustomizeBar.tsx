import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SaveState } from './useCardLayout';

export interface HiddenCardItem {
  id: string;
  title: string;
}

interface Props {
  editing: boolean;
  onToggle: () => void;
  /** The page header's actions area (see `PageHeader`) that takes the switch; without one the switch sits above the cards. */
  toggleSlot: HTMLElement | null;
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

/**
 * The "Customize layout" switch of a page (in the page header) and, while editing, what is not on a card: reset, the hidden
 * cards and the save state. Outside editing it adds nothing to the page but the switch.
 */
export function CustomizeBar({ editing, onToggle, toggleSlot, isDefault, onReset, hidden, onShow, isDesktop, saveState, saveError, onRetry }: Readonly<Props>) {
  const toggle: ReactNode = (
    <button type="button" className={`${editing ? 'btn-primary' : 'btn-secondary'} px-2.5 py-1 text-xs`} aria-pressed={editing} onClick={onToggle}>
      {editing ? 'Done' : 'Customize layout'}
    </button>
  );
  const showDetails = editing || saveState === 'error';
  return (
    <>
      {toggleSlot ? createPortal(toggle, toggleSlot) : <div className="mb-3 flex justify-end">{toggle}</div>}
      {showDetails && (
        <div className="mb-3 flex flex-col gap-2" data-testid="customize-bar">
          {editing && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="muted mr-auto text-xs">{isDesktop ? 'Editing the layout for wide screens' : 'Editing the layout for narrow screens'}</span>
              <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={onReset} disabled={isDefault}>
                Reset to default
              </button>
            </div>
          )}
          {saveState === 'saving' && <p className="muted text-xs">Saving…</p>}
          {saveState === 'error' && (
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
      )}
    </>
  );
}
