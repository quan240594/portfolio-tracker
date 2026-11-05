import { useMemo, useState, type ReactNode } from 'react';
import { isMarketSymbol, type CalendarEvent, type Holding } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useManualDividendMutations } from '../../api/calendarHooks';
import type { ManualActions } from './EventDialog';
import { ManualDividendDialog } from './ManualDividendDialog';

/** The held symbols that can pay a dividend: market symbols, crypto excluded. */
const canPay = (holding: Pick<Holding, 'symbol' | 'assetClass'>): boolean => isMarketSymbol(holding.symbol) && holding.assetClass !== 'CRYPTO';

export interface ManualDividendEntry {
  /** Edit and delete of an entry of the owner, for the event dialog. */
  actions: ManualActions;
  /** The "Add dividend date" button for the page header; absent when nothing held can pay a dividend. */
  addButton: ReactNode;
  /** The add/edit dialog while it is open. */
  dialog: ReactNode;
}

/**
 * The "Add dividend date" workaround of the calendar page: the button, the dialog and the edit and delete actions of an entry the owner made.
 * `closeDetails` closes the event dialog the entry was opened from.
 */
export function useManualDividendEntry(holdings: readonly Holding[] | undefined, closeDetails: () => void): ManualDividendEntry {
  const { remove } = useManualDividendMutations();
  /** `new` adds an entry, an event edits one of the owner's own. */
  const [entry, setEntry] = useState<'new' | CalendarEvent | null>(null);
  const payers = useMemo(() => (holdings ?? []).filter((holding) => canPay(holding)), [holdings]);
  const actions: ManualActions = {
    onEdit: (event) => {
      closeDetails();
      setEntry(event);
    },
    onRemove: (event) => remove.mutate({ symbol: event.symbol, exDate: event.exDate ?? event.date }, { onSuccess: closeDetails }),
    busy: remove.isPending,
    error: remove.isError ? errorMessage(remove.error) : null,
  };
  const addButton =
    payers.length === 0 ? undefined : (
      <button type="button" className="btn-secondary" onClick={() => setEntry('new')}>
        Add dividend date
      </button>
    );
  const dialog = entry === null ? null : <ManualDividendDialog holdings={payers} event={entry === 'new' ? null : entry} onClose={() => setEntry(null)} />;
  return { actions, addButton, dialog };
}
