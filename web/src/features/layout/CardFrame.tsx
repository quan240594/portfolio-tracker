import type { ChangeEvent, ReactNode } from 'react';
import { CARD_WIDTHS, type CardWidth } from '@portfolio/shared';
import type { CardDrag, DropTarget } from './useCardDrag';

/** Grid columns of a card from `md` on (12 columns); below it every card is full width. */
export const WIDTH_CLASS: Record<CardWidth, string> = {
  full: 'md:col-span-12',
  twothirds: 'md:col-span-8',
  half: 'md:col-span-6',
  third: 'md:col-span-4',
};

export const WIDTH_LABEL: Record<CardWidth, string> = { full: 'Full width', twothirds: 'Two thirds', half: 'Half width', third: 'One third' };

const isCardWidth = (value: string): value is CardWidth => (CARD_WIDTHS as readonly string[]).includes(value);

interface Props {
  id: string;
  title: string;
  width: CardWidth;
  editing: boolean;
  /** Whether more than one card width means something (the one-column mobile grid has no use for it). */
  canResize: boolean;
  position: number;
  total: number;
  /** The card is the one being dragged. */
  dragging: boolean;
  /** Where the dragged card would land relative to this one. */
  drop: Pick<DropTarget, 'edge' | 'axis'> | null;
  handleProps: CardDrag['handleProps'];
  onMove: (id: string, direction: 'up' | 'down') => void;
  onWidth: (id: string, width: CardWidth) => void;
  onHide: (id: string) => void;
  children: ReactNode;
}

const DROP_MARK: Record<DropTarget['axis'], Record<DropTarget['edge'], string>> = {
  y: {
    before: 'before:absolute before:-top-2 before:left-0 before:h-1 before:w-full before:rounded before:bg-brand-500',
    after: 'after:absolute after:-bottom-2 after:left-0 after:h-1 after:w-full after:rounded after:bg-brand-500',
  },
  x: {
    before: 'before:absolute before:top-0 before:-left-2 before:h-full before:w-1 before:rounded before:bg-brand-500',
    after: 'after:absolute after:top-0 after:-right-2 after:h-full after:w-1 after:rounded after:bg-brand-500',
  },
};

const iconButton =
  'inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';

/**
 * One cell of the page grid. Outside editing it only places the card; while editing it adds the controls: drag handle,
 * move up/down, width and hide, all native buttons and a native select, so they work by keyboard, mouse and touch.
 */
export function CardFrame({ id, title, width, editing, canResize, position, total, dragging, drop, handleProps, onMove, onWidth, onHide, children }: Readonly<Props>) {
  const onWidthChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (isCardWidth(event.target.value)) onWidth(id, event.target.value);
  };
  // A card whose content is empty (nothing to show right now) takes no room, until the page is being customized.
  const emptyClass = editing ? '' : 'has-[>[data-card-body]:empty]:hidden';
  const classes = ['relative flex min-w-0 flex-col', WIDTH_CLASS[width], emptyClass, dragging ? 'opacity-60' : '', drop ? DROP_MARK[drop.axis][drop.edge] : ''].filter(Boolean).join(' ');

  return (
    <div className={classes} data-card-id={id} data-width={width}>
      {editing && (
        <fieldset className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-brand-400 bg-brand-50/60 p-1.5 dark:bg-slate-800/60">
          <legend className="sr-only">{`Layout of ${title}`}</legend>
          <button type="button" className={`${iconButton} cursor-grab touch-none select-none`} aria-label={`Drag ${title}`} {...handleProps(id)}>
            <span aria-hidden="true">⠿</span>
          </button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium" aria-hidden="true">
            {title}
          </span>
          <span className="muted text-xs">{`${position} of ${total}`}</span>
          <button type="button" className={iconButton} aria-label={`Move ${title} up`} disabled={position <= 1} onClick={() => onMove(id, 'up')}>
            <span aria-hidden="true">↑</span>
          </button>
          <button type="button" className={iconButton} aria-label={`Move ${title} down`} disabled={position >= total} onClick={() => onMove(id, 'down')}>
            <span aria-hidden="true">↓</span>
          </button>
          {canResize && (
            <select className={`${iconButton} pr-1`} aria-label={`Width of ${title}`} value={width} onChange={onWidthChange}>
              {CARD_WIDTHS.map((option) => (
                <option key={option} value={option}>
                  {WIDTH_LABEL[option]}
                </option>
              ))}
            </select>
          )}
          <button type="button" className={iconButton} aria-label={`Hide ${title}`} onClick={() => onHide(id)}>
            <span aria-hidden="true">✕</span>
          </button>
        </fieldset>
      )}
      {/* A grid, so the card stretches to the height of its row like a grid cell did. */}
      <div data-card-body className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]">
        {children}
      </div>
    </div>
  );
}
