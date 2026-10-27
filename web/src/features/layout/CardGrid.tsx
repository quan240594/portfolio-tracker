import { useState, type ReactNode } from 'react';
import { positionOf, type CardWidth, type LayoutPageId, type ResolvedLayout } from '@portfolio/shared';
import { CardFrame, WIDTH_LABEL } from './CardFrame';
import { CustomizeBar } from './CustomizeBar';
import { useCardDrag } from './useCardDrag';
import { useCardLayout } from './useCardLayout';

/** A card of a page as declared in code: a stable id, its default width and what it renders (called only while it is shown). */
export interface CardDefinition {
  id: string;
  title: string;
  defaultWidth: CardWidth;
  render: () => ReactNode;
}

interface Props {
  pageId: LayoutPageId;
  /** In the page's default order; the order the owner chose is applied on top of it. */
  cards: readonly CardDefinition[];
  /** Replaces what is shown when every card is hidden. */
  emptyHint?: ReactNode;
}

const NO_CARDS = 'Every card is hidden. Show one again from the list above, or reset the layout.';

/**
 * A page as a grid of cards the owner can reorder, resize and hide (12 columns from `md`, one column below). It owns the
 * "Customize layout" switch; its layout comes from `useCardLayout`, so a card that is new, renamed or removed in code never
 * breaks a saved layout.
 */
export function CardGrid({ pageId, cards, emptyHint = NO_CARDS }: Readonly<Props>) {
  const cardLayout = useCardLayout(pageId, cards);
  const [editing, setEditing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const titles = new Map(cards.map((card) => [card.id, card.title]));
  const byId = new Map(cards.map((card) => [card.id, card]));
  const titleOf = (id: string): string => titles.get(id) ?? id;

  const announce = (id: string, layout: ResolvedLayout) => {
    const at = positionOf(layout, id);
    setAnnouncement(at ? `${titleOf(id)} is now card ${at.position} of ${at.total}` : `${titleOf(id)} is hidden`);
  };

  const drag = useCardDrag({
    ids: cardLayout.visible.map((card) => card.id),
    onDrop: (id, index) => announce(id, cardLayout.moveTo(id, index)),
  });

  const { visible, hidden, isDesktop } = cardLayout;
  const hiddenItems = hidden.map((card) => ({ id: card.id, title: titleOf(card.id) }));

  return (
    <div>
      <CustomizeBar
        editing={editing}
        onToggle={() => setEditing((on) => !on)}
        isDefault={cardLayout.isDefault}
        onReset={() => {
          cardLayout.reset();
          setAnnouncement('Layout reset to the default');
        }}
        hidden={hiddenItems}
        onShow={(id) => {
          cardLayout.show(id);
          setAnnouncement(`${titleOf(id)} is shown again`);
        }}
        isDesktop={isDesktop}
        saveState={cardLayout.saveState}
        saveError={cardLayout.saveError}
        onRetry={cardLayout.retry}
      />
      <output className="sr-only" aria-live="polite">
        {announcement}
      </output>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-12" data-card-list>
        {visible.map((card, index) => {
          const definition = byId.get(card.id)!;
          const target = drag.target?.id === card.id ? drag.target : null;
          return (
            <CardFrame
              key={card.id}
              id={card.id}
              title={definition.title}
              width={card.width}
              editing={editing}
              canResize={isDesktop}
              position={index + 1}
              total={visible.length}
              dragging={drag.dragId === card.id}
              drop={target}
              handleProps={drag.handleProps}
              onMove={(id, direction) => announce(id, cardLayout.move(id, direction))}
              onWidth={(id, width) => {
                cardLayout.setWidth(id, width);
                setAnnouncement(`${titleOf(id)} is now ${WIDTH_LABEL[width].toLowerCase()}`);
              }}
              onHide={(id) => {
                cardLayout.hide(id);
                setAnnouncement(`${titleOf(id)} is hidden`);
              }}
            >
              {definition.render()}
            </CardFrame>
          );
        })}
      </div>
      {visible.length === 0 && <p className="muted card p-6 text-center text-sm">{emptyHint}</p>}
    </div>
  );
}
