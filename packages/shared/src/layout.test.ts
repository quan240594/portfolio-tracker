import { describe, expect, it } from 'vitest';
import {
  CARD_ID_PATTERN,
  LAYOUT_PAGE_IDS,
  LAYOUT_ROUTES,
  MAX_LAYOUT_CARDS,
  MAX_LAYOUT_PAGES,
  hiddenCards,
  hideCard,
  isCardId,
  isDefaultLayout,
  isLayoutBreakpoint,
  isLayoutPageId,
  layoutKeys,
  layoutOfItem,
  layoutPutSchema,
  moveCard,
  moveCardTo,
  pageLayoutSchema,
  positionOf,
  resetLayout,
  resolveLayout,
  setWidth,
  showCard,
  toStored,
  visibleCards,
  type CardDefault,
  type CardWidth,
  type PageLayout,
  type ResolvedLayout,
} from './layout.js';

const DEFAULTS: CardDefault[] = [
  { id: 'a', defaultWidth: 'full' },
  { id: 'b', defaultWidth: 'half' },
  { id: 'c', defaultWidth: 'half' },
  { id: 'd', defaultWidth: 'third' },
  { id: 'e', defaultWidth: 'third' },
];

const stored = (partial: Partial<PageLayout> = {}): PageLayout => ({ version: 1, breakpoint: 'desktop', order: [], widths: {}, hidden: [], ...partial });
const ids = (layout: ResolvedLayout): string[] => layout.cards.map((card) => card.id);
const visibleIds = (layout: ResolvedLayout): string[] => visibleCards(layout).map((card) => card.id);
const sortedIds = (layout: ResolvedLayout): string[] => [...ids(layout)].sort((x, y) => x.localeCompare(y));

/** Deterministic generator (mulberry32), so the property-style cases are reproducible. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('vocabulary', () => {
  it('keeps the pages within the per-user cap and every page id a valid, unique id', () => {
    expect(LAYOUT_PAGE_IDS.length).toBeLessThanOrEqual(MAX_LAYOUT_PAGES);
    expect(new Set(LAYOUT_PAGE_IDS).size).toBe(LAYOUT_PAGE_IDS.length);
    expect(LAYOUT_PAGE_IDS.every((id) => isCardId(id))).toBe(true);
    expect(isLayoutPageId('dashboard')).toBe(true);
    expect(isLayoutPageId('analytics-growth')).toBe(true);
    expect(isLayoutPageId('asset-detail-dividends')).toBe(true);
    expect(isLayoutPageId('analytics')).toBe(false);
    expect(isLayoutBreakpoint('mobile')).toBe(true);
    expect(isLayoutBreakpoint('tablet')).toBe(false);
    expect(pageLayoutSchema.safeParse(stored({ widths: { a: 'twothirds' } })).success).toBe(true);
    expect(isLayoutPageId('nope')).toBe(false);
  });

  it('validates card ids', () => {
    expect(['a', '0', 'dividends-received', 'a'.repeat(48)].every((id) => isCardId(id))).toBe(true);
    expect(['', '-a', 'A', 'a_b', 'a b', 'a'.repeat(49), 'é'].some((id) => CARD_ID_PATTERN.test(id))).toBe(false);
  });

  it('declares the routes and the storage keys', () => {
    expect(LAYOUT_ROUTES).toEqual({ layoutsGet: 'GET /layouts/{page}', layoutsPut: 'PUT /layouts/{page}/{breakpoint}', layoutsDelete: 'DELETE /layouts/{page}' });
    expect(layoutKeys.layout('u1', 'dashboard', 'mobile')).toEqual({ PK: 'USER#u1', SK: 'LAYOUT#dashboard#mobile' });
    expect(layoutKeys.prefix).toBe('LAYOUT#');
  });
});

describe('pageLayoutSchema', () => {
  it('accepts a layout and the empty overrides', () => {
    expect(pageLayoutSchema.safeParse(stored({ order: ['b', 'a'], widths: { a: 'third' }, hidden: ['c'] })).success).toBe(true);
    expect(pageLayoutSchema.safeParse(stored({ breakpoint: 'mobile' })).success).toBe(true);
  });

  it.each([
    ['another version', { version: 2 }],
    ['another breakpoint', { breakpoint: 'tablet' }],
    ['an invalid card id in the order', { order: ['Bad Id'] }],
    ['a duplicate in the order', { order: ['a', 'a'] }],
    ['a duplicate in the hidden list', { hidden: ['a', 'a'] }],
    ['an invalid card id as a width key', { widths: { 'Bad Id': 'full' } }],
    ['an unknown width', { widths: { a: 'quarter' } }],
    ['an extra property', { extra: true }],
    ['too many ids in the order', { order: Array.from({ length: MAX_LAYOUT_CARDS + 1 }, (_unused, index) => `c${index}`) }],
    ['too many ids in the hidden list', { hidden: Array.from({ length: MAX_LAYOUT_CARDS + 1 }, (_unused, index) => `c${index}`) }],
    ['too many widths', { widths: Object.fromEntries(Array.from({ length: MAX_LAYOUT_CARDS + 1 }, (_unused, index) => [`c${index}`, 'full'])) }],
  ])('refuses %s', (_label, patch) => {
    expect(pageLayoutSchema.safeParse({ ...stored(), ...patch }).success).toBe(false);
  });

  it('accepts the maximum number of cards', () => {
    const many = Array.from({ length: MAX_LAYOUT_CARDS }, (_unused, index) => `c${index}`);
    expect(pageLayoutSchema.safeParse(stored({ order: many, hidden: many, widths: Object.fromEntries(many.map((id) => [id, 'half'])) })).success).toBe(true);
  });

  it('lets a PUT body be null (clears the breakpoint)', () => {
    expect(layoutPutSchema.safeParse(null).success).toBe(true);
    expect(layoutPutSchema.safeParse(stored()).success).toBe(true);
    expect(layoutPutSchema.safeParse({}).success).toBe(false);
    expect(layoutPutSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('layoutOfItem', () => {
  it('reads the layout fields of a stored item and ignores its identity', () => {
    const layout = stored({ order: ['b'], hidden: ['c'], widths: { b: 'full' } });
    expect(layoutOfItem({ PK: 'USER#u', SK: 'LAYOUT#x#desktop', entityType: 'LAYOUT', userId: 'u', page: 'dashboard', updatedAt: 't', ...layout })).toEqual(layout);
  });

  it('answers null for a damaged item', () => {
    expect(layoutOfItem({ version: 1, breakpoint: 'desktop', order: 'x' })).toBeNull();
    expect(layoutOfItem({})).toBeNull();
  });
});

describe('resolveLayout', () => {
  it('is the default layout without a stored one', () => {
    for (const none of [undefined, null, stored()]) {
      const resolved = resolveLayout(DEFAULTS, none);
      expect(resolved.cards).toEqual(DEFAULTS.map((card) => ({ id: card.id, width: card.defaultWidth, hidden: false })));
    }
  });

  it('applies the order, widths and hidden flags', () => {
    const resolved = resolveLayout(DEFAULTS, stored({ order: ['c', 'a', 'b', 'd', 'e'], widths: { a: 'third', e: 'full' }, hidden: ['b'] }));
    expect(ids(resolved)).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(visibleIds(resolved)).toEqual(['c', 'a', 'd', 'e']);
    expect(hiddenCards(resolved).map((card) => card.id)).toEqual(['b']);
    expect(resolved.cards.map((card) => card.width)).toEqual(['half', 'third', 'half', 'third', 'full']);
  });

  it('ignores unknown ids, duplicates and invalid widths of the stored layout', () => {
    const resolved = resolveLayout(DEFAULTS, stored({ order: ['zzz', 'c', 'c', 'a'], widths: { zzz: 'full', b: 'full' }, hidden: ['zzz', 'zzz'] }));
    expect(ids(resolved)).toEqual(['c', 'd', 'e', 'a', 'b']);
    expect(resolved.cards.find((card) => card.id === 'b')?.width).toBe('full');
    expect(hiddenCards(resolved)).toEqual([]);
  });

  it('puts a card that is missing from the stored order at its default place', () => {
    // 'a' and 'e' are new: 'a' leads the page, 'e' follows its default predecessor 'd'.
    expect(ids(resolveLayout(DEFAULTS, stored({ order: ['d', 'c', 'b'] })))).toEqual(['a', 'd', 'e', 'c', 'b']);
    // Several new cards in a row keep their default order.
    expect(ids(resolveLayout(DEFAULTS, stored({ order: ['c'] })))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(resolveLayout(DEFAULTS, stored({ order: ['e'] })))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(resolveLayout(DEFAULTS, stored({ order: ['b', 'a'] })))).toEqual(['b', 'c', 'd', 'e', 'a']);
  });

  it('drops cards that are no longer declared', () => {
    expect(ids(resolveLayout(DEFAULTS.slice(0, 2), stored({ order: ['e', 'b', 'a'], hidden: ['e'] })))).toEqual(['b', 'a']);
  });

  it('ignores a duplicated declaration', () => {
    expect(ids(resolveLayout([...DEFAULTS, { id: 'a', defaultWidth: 'third' }], null))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('copes with a page without cards', () => {
    expect(resolveLayout([], stored({ order: ['a'], hidden: ['a'] })).cards).toEqual([]);
  });
});

describe('moveCard', () => {
  const base = resolveLayout(DEFAULTS, null);

  it('moves a card up and down', () => {
    expect(ids(moveCard(base, 'c', 'up'))).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(ids(moveCard(base, 'c', 'down'))).toEqual(['a', 'b', 'd', 'c', 'e']);
  });

  it('is a no-op at the ends and for unknown or hidden cards', () => {
    expect(moveCard(base, 'a', 'up')).toBe(base);
    expect(moveCard(base, 'e', 'down')).toBe(base);
    expect(moveCard(base, 'nope', 'down')).toBe(base);
    const hidden = hideCard(base, 'b');
    expect(moveCard(hidden, 'b', 'down')).toBe(hidden);
  });

  it('steps over hidden cards and leaves them in their slots', () => {
    const hidden = hideCard(base, 'b');
    expect(ids(moveCard(hidden, 'c', 'up'))).toEqual(['c', 'b', 'a', 'd', 'e']);
    expect(visibleIds(moveCard(hidden, 'c', 'up'))).toEqual(['c', 'a', 'd', 'e']);
    expect(ids(moveCard(hidden, 'a', 'down'))).toEqual(['c', 'b', 'a', 'd', 'e']);
  });

  it('does not change the input', () => {
    const before = structuredClone(base);
    moveCard(base, 'c', 'up');
    expect(base).toEqual(before);
  });
});

describe('moveCardTo', () => {
  const base = resolveLayout(DEFAULTS, null);

  it('moves a card to a visible index', () => {
    expect(ids(moveCardTo(base, 'a', 3))).toEqual(['b', 'c', 'd', 'a', 'e']);
    expect(ids(moveCardTo(base, 'e', 0))).toEqual(['e', 'a', 'b', 'c', 'd']);
  });

  it('clamps the target and ignores fractions', () => {
    expect(ids(moveCardTo(base, 'a', 99))).toEqual(['b', 'c', 'd', 'e', 'a']);
    expect(ids(moveCardTo(base, 'e', -4))).toEqual(['e', 'a', 'b', 'c', 'd']);
    expect(ids(moveCardTo(base, 'a', 1.9))).toEqual(['b', 'a', 'c', 'd', 'e']);
  });

  it('is a no-op when the card stays where it is, is unknown or hidden', () => {
    expect(moveCardTo(base, 'c', 2)).toBe(base);
    expect(moveCardTo(base, 'nope', 0)).toBe(base);
    expect(moveCardTo(hideCard(base, 'c'), 'c', 0).cards.map((card) => card.id)).toEqual(ids(base));
  });

  it('counts only the visible cards', () => {
    const hidden = hideCard(hideCard(base, 'b'), 'd');
    expect(visibleIds(moveCardTo(hidden, 'a', 2))).toEqual(['c', 'e', 'a']);
    expect(ids(moveCardTo(hidden, 'a', 2))).toEqual(['c', 'b', 'e', 'd', 'a']);
  });
});

describe('setWidth, hideCard, showCard', () => {
  const base = resolveLayout(DEFAULTS, null);

  it('sets the width of a card', () => {
    expect(setWidth(base, 'b', 'full').cards[1]).toEqual({ id: 'b', width: 'full', hidden: false });
    expect(setWidth(base, 'b', 'half')).toBe(base);
    expect(setWidth(base, 'nope', 'full')).toBe(base);
  });

  it('hides a card and shows it again at its place', () => {
    const hidden = hideCard(base, 'b');
    expect(hiddenCards(hidden).map((card) => card.id)).toEqual(['b']);
    expect(hideCard(hidden, 'b')).toBe(hidden);
    expect(hideCard(base, 'nope')).toBe(base);
    expect(showCard(hidden, 'b')).toEqual(base);
    expect(showCard(base, 'b')).toBe(base);
    expect(showCard(base, 'nope')).toBe(base);
  });

  it('can hide every card', () => {
    const none = DEFAULTS.reduce((layout, card) => hideCard(layout, card.id), base);
    expect(visibleCards(none)).toEqual([]);
    expect(hiddenCards(none)).toHaveLength(DEFAULTS.length);
  });

  it('keeps the width of a hidden card', () => {
    expect(showCard(hideCard(setWidth(base, 'b', 'third'), 'b'), 'b').cards[1]?.width).toBe('third');
  });
});

describe('positionOf', () => {
  it('counts the visible cards', () => {
    const layout = hideCard(resolveLayout(DEFAULTS, null), 'b');
    expect(positionOf(layout, 'c')).toEqual({ position: 2, total: 4 });
    expect(positionOf(layout, 'b')).toBeNull();
    expect(positionOf(layout, 'nope')).toBeNull();
  });
});

describe('resetLayout and isDefaultLayout', () => {
  it('restores the defaults', () => {
    const edited = hideCard(setWidth(moveCard(resolveLayout(DEFAULTS, null), 'c', 'up'), 'a', 'third'), 'e');
    expect(isDefaultLayout(DEFAULTS, edited)).toBe(false);
    expect(resetLayout(DEFAULTS)).toEqual(resolveLayout(DEFAULTS, null));
    expect(isDefaultLayout(DEFAULTS, resetLayout(DEFAULTS))).toBe(true);
  });
});

describe('toStored', () => {
  const base = resolveLayout(DEFAULTS, null);

  it('is null when the layout equals the defaults', () => {
    expect(toStored(DEFAULTS, base, 'desktop')).toBeNull();
    expect(toStored(DEFAULTS, base, 'mobile')).toBeNull();
  });

  it('stores only the overrides', () => {
    expect(toStored(DEFAULTS, setWidth(base, 'd', 'full'), 'desktop')).toEqual(stored({ widths: { d: 'full' } }));
    expect(toStored(DEFAULTS, hideCard(base, 'c'), 'mobile')).toEqual(stored({ breakpoint: 'mobile', hidden: ['c'] }));
    expect(toStored(DEFAULTS, moveCard(base, 'b', 'down'), 'desktop')).toEqual(stored({ order: ['a', 'c', 'b', 'd', 'e'] }));
  });

  it('is null again once the edits are undone', () => {
    const edited = setWidth(hideCard(moveCard(base, 'b', 'down'), 'e'), 'a', 'half');
    const undone = setWidth(showCard(moveCard(edited, 'b', 'up'), 'e'), 'a', 'full');
    expect(toStored(DEFAULTS, undone, 'desktop')).toBeNull();
  });

  it('ignores cards that are not declared', () => {
    const foreign: ResolvedLayout = { cards: [...base.cards, { id: 'ghost', width: 'full', hidden: true }] };
    expect(toStored(DEFAULTS, foreign, 'desktop')).toBeNull();
  });

  it('produces a layout that passes the schema', () => {
    const edited = setWidth(hideCard(moveCard(base, 'e', 'up'), 'a'), 'b', 'third');
    expect(pageLayoutSchema.safeParse(toStored(DEFAULTS, edited, 'desktop')).success).toBe(true);
  });
});

describe('properties over random edits', () => {
  const WIDTHS: CardWidth[] = ['full', 'twothirds', 'half', 'third'];

  function edit(layout: ResolvedLayout, next: () => number): ResolvedLayout {
    const id = DEFAULTS[Math.floor(next() * DEFAULTS.length)]!.id;
    const action = Math.floor(next() * 6);
    if (action === 0) return moveCard(layout, id, 'up');
    if (action === 1) return moveCard(layout, id, 'down');
    if (action === 2) return moveCardTo(layout, id, Math.floor(next() * (DEFAULTS.length + 2)) - 1);
    if (action === 3) return setWidth(layout, id, WIDTHS[Math.floor(next() * WIDTHS.length)]!);
    if (action === 4) return hideCard(layout, id);
    return showCard(layout, id);
  }

  it('keeps every declared card exactly once and round-trips through toStored and resolveLayout', () => {
    const next = generator(20261027);
    for (let round = 0; round < 200; round++) {
      let layout = resolveLayout(DEFAULTS, null);
      for (let step = 0; step < 12; step++) {
        const before = layout;
        layout = edit(layout, next);
        expect(sortedIds(layout)).toEqual(DEFAULTS.map((card) => card.id));
        // Moving never changes widths or the hidden set.
        if (layout !== before) expect(hiddenCards(layout).length + visibleCards(layout).length).toBe(DEFAULTS.length);
      }
      const keep = toStored(DEFAULTS, layout, 'desktop');
      expect(resolveLayout(DEFAULTS, keep)).toEqual(layout);
      if (keep) expect(pageLayoutSchema.safeParse(keep).success).toBe(true);
      expect(isDefaultLayout(DEFAULTS, layout)).toBe(keep === null);
    }
  });

  it('moves keep the relative order of the other visible cards', () => {
    const next = generator(7);
    for (let round = 0; round < 100; round++) {
      const layout = Array.from({ length: 4 }, () => DEFAULTS[Math.floor(next() * DEFAULTS.length)]!.id).reduce(hideCard, resolveLayout(DEFAULTS, null));
      const id = DEFAULTS[Math.floor(next() * DEFAULTS.length)]!.id;
      const moved = moveCardTo(layout, id, Math.floor(next() * DEFAULTS.length));
      expect(visibleIds(moved).filter((other) => other !== id)).toEqual(visibleIds(layout).filter((other) => other !== id));
      expect(hiddenCards(moved)).toEqual(hiddenCards(layout));
    }
  });

  it('resolves any stored layout, however stale, to the declared cards', () => {
    const next = generator(99);
    const pool = [...DEFAULTS.map((card) => card.id), 'x', 'y', 'z'];
    const pick = () => pool[Math.floor(next() * pool.length)]!;
    for (let round = 0; round < 200; round++) {
      const messy = stored({ order: Array.from({ length: Math.floor(next() * 8) }, pick), hidden: Array.from({ length: Math.floor(next() * 5) }, pick) });
      const resolved = resolveLayout(DEFAULTS, messy);
      expect(sortedIds(resolved)).toEqual(DEFAULTS.map((card) => card.id));
    }
  });
});
