/**
 * Modular page layouts: every page is a grid of cards the owner can reorder, resize and hide (see docs/architecture.md
 * "Modular page layouts"). The default layout of a page is declared in the web app's code; what is stored per user is only
 * the owner's overrides, one layout per page and breakpoint (desktop: >= md, mobile: < md).
 *
 * REST contract (all authenticated, user scoped; errors use the standard envelope):
 * - GET    /layouts/{page}               `{ desktop: PageLayout | null, mobile: PageLayout | null }`, null = never customised
 * - PUT    /layouts/{page}/{breakpoint}  body = PageLayout of that breakpoint (max 8 KB), or `null` to clear it; answers 204
 * - DELETE /layouts/{page}               clears both breakpoints (204, also when none was stored)
 *
 * The helpers below are pure: they turn the declared defaults plus a stored layout into what is shown (`resolveLayout`),
 * apply one edit (`moveCard`, `setWidth`, `hideCard`, ...) and turn the result back into what is stored (`toStored`).
 */
import { z } from 'zod';

export const LAYOUT_ROUTES = {
  layoutsGet: 'GET /layouts/{page}',
  layoutsPut: 'PUT /layouts/{page}/{breakpoint}',
  layoutsDelete: 'DELETE /layouts/{page}',
} as const;

// --- Single-table item (PK USER#{userId}, SK LAYOUT#{page}#{breakpoint}, entityType LAYOUT) ------------------------------

export const LAYOUT_ENTITY = 'LAYOUT';

export const layoutKeys = {
  layout: (userId: string, page: string, breakpoint: string) => ({ PK: `USER#${userId}`, SK: `LAYOUT#${page}#${breakpoint}` }),
  /** Every layout of a user. */
  prefix: 'LAYOUT#',
} as const;

// --- Vocabulary -----------------------------------------------------------------------------------------------------------

export const CARD_WIDTHS = ['full', 'twothirds', 'half', 'third'] as const;
export type CardWidth = (typeof CARD_WIDTHS)[number];

export const LAYOUT_BREAKPOINTS = ['desktop', 'mobile'] as const;
export type LayoutBreakpoint = (typeof LAYOUT_BREAKPOINTS)[number];

/**
 * The screens that can hold cards; a closed list, so a user never stores more than `MAX_LAYOUT_PAGES` pages. A tabbed page
 * (analytics, asset detail) has one layout per tab: `<page>-<tab>`.
 */
export const LAYOUT_PAGE_IDS = [
  'dashboard',
  'holdings',
  'dividends',
  'calendar',
  'earnings',
  'transactions',
  'analytics-growth',
  'analytics-metrics',
  'analytics-returns',
  'analytics-risk',
  'analytics-benchmark',
  'analytics-dividends',
  'analytics-goal',
  'goals',
  'rebalance',
  'assets',
  'asset-detail-overview',
  'asset-detail-dividends',
  'watchlist',
  'brokers',
  'notifications',
  'diagnostics',
] as const;
export type LayoutPageId = (typeof LAYOUT_PAGE_IDS)[number];

export const MAX_LAYOUT_CARDS = 60;
export const MAX_LAYOUT_PAGES = 30;
export const MAX_LAYOUT_BODY_BYTES = 8 * 1024;
export const CARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const isLayoutPageId = (value: string): value is LayoutPageId => (LAYOUT_PAGE_IDS as readonly string[]).includes(value);
export const isLayoutBreakpoint = (value: string): value is LayoutBreakpoint => (LAYOUT_BREAKPOINTS as readonly string[]).includes(value);
export const isCardId = (value: string): boolean => CARD_ID_PATTERN.test(value);

// --- Stored layout -----------------------------------------------------------------------------------------------------------

/** What is stored for one page and breakpoint: only the owner's overrides (see `toStored`). */
export interface PageLayout {
  version: 1;
  breakpoint: LayoutBreakpoint;
  /** Card ids in the owner's order; empty = the default order. */
  order: string[];
  /** Widths that differ from the card's default. */
  widths: Record<string, CardWidth>;
  /** Ids of the hidden cards. */
  hidden: string[];
}

export interface PageLayoutsResponse {
  desktop: PageLayout | null;
  mobile: PageLayout | null;
}

/** The stored item: the layout plus the identity it belongs to. */
export interface PageLayoutItem extends PageLayout {
  userId: string;
  page: LayoutPageId;
  updatedAt: string;
}

const cardIdSchema = z.string().regex(CARD_ID_PATTERN, 'Card ids are lower-case letters, digits and hyphens (1 to 48 characters)');
const hasNoDuplicates = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

export const pageLayoutSchema = z
  .object({
    version: z.literal(1),
    breakpoint: z.enum(LAYOUT_BREAKPOINTS),
    order: z.array(cardIdSchema).max(MAX_LAYOUT_CARDS).refine(hasNoDuplicates, 'Card ids must be unique'),
    widths: z
      .record(cardIdSchema, z.enum(CARD_WIDTHS))
      .refine((widths) => Object.keys(widths).length <= MAX_LAYOUT_CARDS, `At most ${MAX_LAYOUT_CARDS} widths`),
    hidden: z.array(cardIdSchema).max(MAX_LAYOUT_CARDS).refine(hasNoDuplicates, 'Card ids must be unique'),
  })
  .strict();

/** The body of `PUT /layouts/{page}/{breakpoint}`: a layout, or null to clear the breakpoint. */
export const layoutPutSchema = pageLayoutSchema.nullable();

/** The layout stored in an item, or null when it is not a valid layout (a damaged item is ignored, never served). */
export function layoutOfItem(item: object): PageLayout | null {
  const { version, breakpoint, order, widths, hidden } = item as Partial<Record<keyof PageLayout, unknown>>;
  const parsed = pageLayoutSchema.safeParse({ version, breakpoint, order, widths, hidden });
  return parsed.success ? parsed.data : null;
}

// --- Defaults and resolved layouts -----------------------------------------------------------------------------------------

/** One card of a page as declared in code, in the page's default order. */
export interface CardDefault {
  id: string;
  defaultWidth: CardWidth;
}

export interface ResolvedCard {
  id: string;
  width: CardWidth;
  hidden: boolean;
}

/** Every card of the page in the order shown; a hidden card keeps its slot so that showing it again restores its place. */
export interface ResolvedLayout {
  cards: readonly ResolvedCard[];
}

export type MoveDirection = 'up' | 'down';

const uniqueDefaults = (defaults: readonly CardDefault[]): CardDefault[] => {
  const seen = new Set<string>();
  const unique: CardDefault[] = [];
  for (const card of defaults) {
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    unique.push(card);
  }
  return unique;
};

/** The stored order restricted to known ids (first occurrence wins), then every missing card after its default predecessor. */
function mergedOrder(defaults: readonly CardDefault[], storedOrder: readonly string[]): string[] {
  const known = new Set(defaults.map((card) => card.id));
  const order = [...new Set(storedOrder)].filter((id) => known.has(id));
  const present = new Set(order);
  let previous: string | undefined;
  for (const { id } of defaults) {
    if (!present.has(id)) {
      const at = previous === undefined ? 0 : order.indexOf(previous) + 1;
      order.splice(at, 0, id);
      present.add(id);
    }
    previous = id;
  }
  return order;
}

/** What to show for `defaults` given the stored overrides: unknown ids are ignored, missing ones appear at their default place. */
export function resolveLayout(defaults: readonly CardDefault[], stored?: PageLayout | null): ResolvedLayout {
  const cards = uniqueDefaults(defaults);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const hidden = new Set(stored?.hidden ?? []);
  const widths = stored?.widths ?? {};
  const order = mergedOrder(cards, stored?.order ?? []);
  return {
    cards: order.map((id) => ({ id, width: widths[id] ?? byId.get(id)!.defaultWidth, hidden: hidden.has(id) })),
  };
}

export const visibleCards = (layout: ResolvedLayout): ResolvedCard[] => layout.cards.filter((card) => !card.hidden);
export const hiddenCards = (layout: ResolvedLayout): ResolvedCard[] => layout.cards.filter((card) => card.hidden);

/** 1-based position of a visible card among the visible ones, or null when it is hidden or unknown. */
export function positionOf(layout: ResolvedLayout, id: string): { position: number; total: number } | null {
  const visible = visibleCards(layout);
  const index = visible.findIndex((card) => card.id === id);
  return index === -1 ? null : { position: index + 1, total: visible.length };
}

/** Puts the visible cards in `visible` order; hidden cards stay in their slots. */
function withVisibleOrder(layout: ResolvedLayout, visible: readonly ResolvedCard[]): ResolvedLayout {
  const queue = [...visible];
  return { cards: layout.cards.map((card) => (card.hidden ? card : queue.shift()!)) };
}

/** Moves a visible card to index `target` (0-based) among the visible cards; out-of-range targets are clamped. */
export function moveCardTo(layout: ResolvedLayout, id: string, target: number): ResolvedLayout {
  const visible = visibleCards(layout);
  const from = visible.findIndex((card) => card.id === id);
  if (from === -1) return layout;
  const to = Math.min(Math.max(Math.trunc(target), 0), visible.length - 1);
  if (to === from) return layout;
  const reordered = visible.filter((card) => card.id !== id);
  reordered.splice(to, 0, visible[from]!);
  return withVisibleOrder(layout, reordered);
}

/** Moves a visible card one place up or down among the visible cards; a no-op at either end. */
export function moveCard(layout: ResolvedLayout, id: string, direction: MoveDirection): ResolvedLayout {
  const index = visibleCards(layout).findIndex((card) => card.id === id);
  if (index === -1) return layout;
  return moveCardTo(layout, id, direction === 'up' ? index - 1 : index + 1);
}

const mapCard = (layout: ResolvedLayout, id: string, change: (card: ResolvedCard) => ResolvedCard): ResolvedLayout => {
  const index = layout.cards.findIndex((card) => card.id === id);
  if (index === -1) return layout;
  const current = layout.cards[index]!;
  const changed = change(current);
  if (changed === current) return layout;
  return { cards: layout.cards.map((card, at) => (at === index ? changed : card)) };
};

export const setWidth = (layout: ResolvedLayout, id: string, width: CardWidth): ResolvedLayout =>
  mapCard(layout, id, (card) => (card.width === width ? card : { ...card, width }));

export const hideCard = (layout: ResolvedLayout, id: string): ResolvedLayout => mapCard(layout, id, (card) => (card.hidden ? card : { ...card, hidden: true }));

export const showCard = (layout: ResolvedLayout, id: string): ResolvedLayout => mapCard(layout, id, (card) => (card.hidden ? { ...card, hidden: false } : card));

/** The default layout of the page. */
export const resetLayout = (defaults: readonly CardDefault[]): ResolvedLayout => resolveLayout(defaults, null);

/** Whether the resolved layout is exactly the default one. */
export function isDefaultLayout(defaults: readonly CardDefault[], layout: ResolvedLayout): boolean {
  return toStored(defaults, layout, 'desktop') === null;
}

/** The overrides to store for `layout`, or null when it equals the defaults (then nothing needs to be stored). */
export function toStored(defaults: readonly CardDefault[], layout: ResolvedLayout, breakpoint: LayoutBreakpoint): PageLayout | null {
  const declared = uniqueDefaults(defaults);
  const defaultWidths = new Map(declared.map((card) => [card.id, card.defaultWidth]));
  const cards = layout.cards.filter((card) => defaultWidths.has(card.id));
  const ids = cards.map((card) => card.id);
  const defaultOrder = declared.map((card) => card.id);
  const widths: Record<string, CardWidth> = {};
  for (const card of cards) {
    if (defaultWidths.get(card.id) !== card.width) widths[card.id] = card.width;
  }
  const hidden = cards.filter((card) => card.hidden).map((card) => card.id);
  const sameOrder = ids.length === defaultOrder.length && ids.every((id, index) => id === defaultOrder[index]);
  if (sameOrder && hidden.length === 0 && Object.keys(widths).length === 0) return null;
  return { version: 1, breakpoint, order: sameOrder ? [] : ids, widths, hidden };
}
