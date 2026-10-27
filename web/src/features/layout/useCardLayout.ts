import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  hiddenCards,
  hideCard,
  isDefaultLayout,
  moveCard,
  moveCardTo,
  resetLayout,
  resolveLayout,
  setWidth as setCardWidth,
  showCard,
  toStored,
  visibleCards,
  type CardDefault,
  type CardWidth,
  type LayoutBreakpoint,
  type LayoutPageId,
  type MoveDirection,
  type PageLayout,
  type PageLayoutsResponse,
  type ResolvedCard,
  type ResolvedLayout,
} from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useLayoutStore } from './layoutStore';
import { DESKTOP_QUERY, useMediaQuery } from './useMediaQuery';

/** Edits are saved this long after the last one, so dragging a card around makes one request, not many. */
export const SAVE_DEBOUNCE_MS = 600;

export type SaveState = 'idle' | 'saving' | 'error';

const NOTHING_STORED: PageLayoutsResponse = { desktop: null, mobile: null };

export const layoutQueryKey = (page: LayoutPageId) => ['layouts', page] as const;

export interface CardLayout {
  breakpoint: LayoutBreakpoint;
  isDesktop: boolean;
  /** Every card in the order shown (hidden ones keep their slot). */
  layout: ResolvedLayout;
  visible: ResolvedCard[];
  hidden: ResolvedCard[];
  /** Whether the layout still equals the page's declared defaults. */
  isDefault: boolean;
  /** Each edit applies at once (optimistic) and answers the layout it produced; a no-op answers the current one. */
  move(id: string, direction: MoveDirection): ResolvedLayout;
  moveTo(id: string, index: number): ResolvedLayout;
  setWidth(id: string, width: CardWidth): ResolvedLayout;
  hide(id: string): ResolvedLayout;
  show(id: string): ResolvedLayout;
  /** Back to the page's defaults, saved at once. */
  reset(): ResolvedLayout;
  saveState: SaveState;
  saveError: string | null;
  /** Sends again what could not be saved. */
  retry(): void;
}

/**
 * The layout of one page for the current breakpoint: the stored overrides applied to `defaults`, edited optimistically and
 * saved (debounced) through the layout store. The page always renders: while the stored layout loads, or when it cannot be
 * loaded, the defaults (or this browser's last copy) are shown.
 */
export function useCardLayout(pageId: LayoutPageId, defaults: readonly CardDefault[]): CardLayout {
  const store = useLayoutStore();
  const qc = useQueryClient();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const breakpoint: LayoutBreakpoint = isDesktop ? 'desktop' : 'mobile';
  const key = useMemo(() => layoutQueryKey(pageId), [pageId]);

  // Only the ids and widths matter: a page may pass a fresh array (with fresh render functions) on every render.
  const declaredKey = defaults.map((card) => `${card.id}:${card.defaultWidth}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `declaredKey` is the content of `defaults`
  const declared = useMemo(() => defaults.map(({ id, defaultWidth }) => ({ id, defaultWidth })), [declaredKey]);

  const query = useQuery<PageLayoutsResponse>({
    queryKey: key,
    queryFn: ({ signal }) => store.load(pageId, signal),
    staleTime: Infinity,
    placeholderData: () => store.cached(pageId) ?? undefined,
  });
  const stored = query.data?.[breakpoint] ?? null;
  const layout = useMemo(() => resolveLayout(declared, stored), [declared, stored]);

  const pending = useRef(new Map<LayoutBreakpoint, PageLayout | null>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const batch = [...pending.current];
    pending.current.clear();
    if (batch.length === 0) return;
    setSaveState('saving');
    // One request chain, so an older save can never arrive after a newer one.
    chain.current = chain.current
      .then(() => Promise.all(batch.map(([at, saved]) => store.save(pageId, at, saved))))
      .then(
        () => {
          if (pending.current.size === 0) setSaveState('idle');
          setSaveError(null);
        },
        (error: unknown) => {
          for (const [at, saved] of batch) if (!pending.current.has(at)) pending.current.set(at, saved);
          setSaveError(errorMessage(error));
          setSaveState('error');
        },
      );
  }, [store, pageId]);

  // Leaving the page must not lose the last edits.
  useEffect(() => flush, [flush]);

  /** What is stored now, including edits that are not saved yet. */
  const readStored = useCallback((): PageLayoutsResponse => qc.getQueryData<PageLayoutsResponse>(key) ?? store.cached(pageId) ?? NOTHING_STORED, [qc, key, store, pageId]);

  const writeStored = useCallback(
    (next: PageLayout | null) => {
      // A load that is still on its way must not overwrite the edit.
      void qc.cancelQueries({ queryKey: key });
      qc.setQueryData<PageLayoutsResponse>(key, { ...readStored(), [breakpoint]: next });
      pending.current.set(breakpoint, next);
    },
    [qc, key, readStored, breakpoint],
  );

  const edit = (change: (current: ResolvedLayout) => ResolvedLayout): ResolvedLayout => {
    const current = resolveLayout(declared, readStored()[breakpoint]);
    const next = change(current);
    if (next === current) return current;
    writeStored(toStored(declared, next, breakpoint));
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    return next;
  };

  const reset = (): ResolvedLayout => {
    if (readStored()[breakpoint] === null && !pending.current.has(breakpoint)) return layout;
    writeStored(null);
    flush();
    return resetLayout(declared);
  };

  return {
    breakpoint,
    isDesktop,
    layout,
    visible: visibleCards(layout),
    hidden: hiddenCards(layout),
    isDefault: isDefaultLayout(declared, layout),
    move: (id, direction) => edit((current) => moveCard(current, id, direction)),
    moveTo: (id, index) => edit((current) => moveCardTo(current, id, index)),
    setWidth: (id, width) => edit((current) => setCardWidth(current, id, width)),
    hide: (id) => edit((current) => hideCard(current, id)),
    show: (id) => edit((current) => showCard(current, id)),
    reset,
    saveState,
    saveError,
    retry: flush,
  };
}
