import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export type DropEdge = 'before' | 'after';

/** Where a dragged card would land: next to card `id`, on its `edge`; `axis` is the direction the cards sit in (side by side or stacked). */
export interface DropTarget {
  id: string;
  edge: DropEdge;
  axis: 'x' | 'y';
}

/** Distance from the viewport edge where scrolling starts, and the fastest scroll step (pixels per frame). */
export const AUTO_SCROLL_EDGE = 72;
export const AUTO_SCROLL_MAX_STEP = 18;

/** Index (among the visible cards without the dragged one) the dragged card ends up at; null when there is no valid target. */
export function dropIndex(ids: readonly string[], dragId: string, target: Pick<DropTarget, 'id' | 'edge'> | null): number | null {
  if (target === null) return null;
  const rest = ids.filter((id) => id !== dragId);
  const at = rest.indexOf(target.id);
  if (at === -1) return null;
  return target.edge === 'before' ? at : at + 1;
}

/** Pixels to scroll this frame: negative near the top (below the sticky header), positive near the bottom, 0 elsewhere. */
export function autoScrollDelta(pointerY: number, viewportHeight: number, topInset: number): number {
  const top = topInset + AUTO_SCROLL_EDGE;
  const bottom = viewportHeight - AUTO_SCROLL_EDGE;
  if (pointerY < top) return -Math.round(AUTO_SCROLL_MAX_STEP * Math.min(1, (top - pointerY) / AUTO_SCROLL_EDGE));
  if (pointerY > bottom) return Math.round(AUTO_SCROLL_MAX_STEP * Math.min(1, (pointerY - bottom) / AUTO_SCROLL_EDGE));
  return 0;
}

const LIST_SELECTOR = '[data-card-list]';
const CARD_SELECTOR = '[data-card-id]';

/** The drop target under a point: the card there, none outside the card list, `undefined` over a gap between cards. */
function targetAt(x: number, y: number, dragId: string): DropTarget | null | undefined {
  const element = document.elementFromPoint(x, y);
  const card = element?.closest<HTMLElement>(CARD_SELECTOR);
  if (!card) return element?.closest(LIST_SELECTOR) ? undefined : null;
  const id = card.dataset.cardId!;
  if (id === dragId) return null;
  const rect = card.getBoundingClientRect();
  const listWidth = card.closest(LIST_SELECTOR)?.getBoundingClientRect().width ?? rect.width;
  const axis = rect.width < listWidth * 0.95 ? 'x' : 'y';
  const before = axis === 'x' ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2;
  return { id, axis, edge: before ? 'before' : 'after' };
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null): boolean => a?.id === b?.id && a?.edge === b?.edge && a?.axis === b?.axis;

const stickyInset = (): number => Number.parseFloat(document.documentElement.style.getPropertyValue('--sticky-offset')) || 0;

interface Options {
  /** The visible card ids in order. */
  ids: readonly string[];
  /** Called once on release over a target; `index` counts the visible cards without the dragged one. */
  onDrop: (id: string, index: number) => void;
}

export interface CardDrag {
  dragId: string | null;
  target: DropTarget | null;
  /** Spread on the drag handle of card `id`. */
  handleProps: (id: string) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
    onLostPointerCapture: () => void;
  };
}

/**
 * Pointer-event drag and drop of the cards (mouse, pen and touch alike): press on a card's handle, move over another card
 * (the drop target shows where it lands), release to drop; Escape or a cancelled pointer cancels. Near the top or bottom of
 * the viewport the page scrolls. No dependency: the handle captures the pointer and the card under it is found by position.
 */
export function useCardDrag({ ids, onDrop }: Readonly<Options>): CardDrag {
  const [dragId, setDragId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const active = useRef<{ id: string; pointerId: number; x: number; y: number } | null>(null);
  const targetRef = useRef<DropTarget | null>(null);
  const frame = useRef<number | undefined>(undefined);

  const updateTarget = useCallback(() => {
    const drag = active.current;
    if (!drag) return;
    const found = targetAt(drag.x, drag.y, drag.id);
    if (found === undefined || sameTarget(found, targetRef.current)) return;
    targetRef.current = found;
    setTarget(found);
  }, []);

  const stop = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    active.current = null;
    targetRef.current = null;
    setDragId(null);
    setTarget(null);
  }, []);

  const scrollLoop = useCallback(() => {
    const drag = active.current;
    if (!drag) return;
    const delta = autoScrollDelta(drag.y, window.innerHeight, stickyInset());
    if (delta !== 0) {
      window.scrollBy(0, delta);
      // The cards moved under a pointer that did not.
      updateTarget();
    }
    frame.current = requestAnimationFrame(scrollLoop);
  }, [updateTarget]);

  useEffect(() => {
    if (dragId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      stop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dragId, stop]);

  useEffect(() => stop, [stop]);

  const handleProps: CardDrag['handleProps'] = (id) => ({
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      active.current = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      setDragId(id);
      frame.current = requestAnimationFrame(scrollLoop);
    },
    onPointerMove: (event) => {
      const drag = active.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      updateTarget();
    },
    onPointerUp: (event) => {
      const drag = active.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const index = dropIndex(ids, drag.id, targetRef.current);
      const moved = drag.id;
      stop();
      if (index !== null) onDrop(moved, index);
    },
    onPointerCancel: stop,
    onLostPointerCapture: stop,
  });

  return { dragId, target, handleProps };
}
