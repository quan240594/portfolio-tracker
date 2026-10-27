import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import type { LayoutBreakpoint, LayoutPageId, PageLayout, PageLayoutsResponse } from '@portfolio/shared';
import { CardGrid, type CardDefinition } from './CardGrid';
import { LayoutStoreProvider, type LayoutStore } from './layoutStore';
import { AUTO_SCROLL_EDGE, AUTO_SCROLL_MAX_STEP, autoScrollDelta, dropIndex } from './useCardDrag';

describe('dropIndex', () => {
  const ids = ['a', 'b', 'c', 'd'];
  it('is the place among the other cards', () => {
    expect(dropIndex(ids, 'a', { id: 'c', edge: 'after' })).toBe(2);
    expect(dropIndex(ids, 'a', { id: 'c', edge: 'before' })).toBe(1);
    expect(dropIndex(ids, 'd', { id: 'a', edge: 'before' })).toBe(0);
    expect(dropIndex(ids, 'b', { id: 'd', edge: 'after' })).toBe(3);
  });
  it('is null without a valid target', () => {
    expect(dropIndex(ids, 'a', null)).toBeNull();
    expect(dropIndex(ids, 'a', { id: 'zzz', edge: 'after' })).toBeNull();
    expect(dropIndex(ids, 'a', { id: 'a', edge: 'after' })).toBeNull();
  });
});

describe('autoScrollDelta', () => {
  it('scrolls near the top (below the sticky header) and near the bottom, not in the middle', () => {
    expect(autoScrollDelta(400, 800, 0)).toBe(0);
    expect(autoScrollDelta(0, 800, 0)).toBe(-AUTO_SCROLL_MAX_STEP);
    expect(autoScrollDelta(100, 800, 60)).toBe(-8);
    expect(autoScrollDelta(800, 800, 0)).toBe(AUTO_SCROLL_MAX_STEP);
    expect(autoScrollDelta(800 - AUTO_SCROLL_EDGE / 2, 800, 0)).toBe(AUTO_SCROLL_MAX_STEP / 2);
  });
});

const WIDTH_PX: Record<string, number> = { full: 1000, half: 480, third: 320 };
const cards: CardDefinition[] = [
  { id: 'a', title: 'Alpha', defaultWidth: 'full', render: () => <p>Alpha body</p> },
  { id: 'b', title: 'Beta', defaultWidth: 'half', render: () => <p>Beta body</p> },
  { id: 'c', title: 'Gamma', defaultWidth: 'half', render: () => <p>Gamma body</p> },
];

function memoryStore() {
  const save = vi.fn((_page: LayoutPageId, _breakpoint: LayoutBreakpoint, _layout: PageLayout | null) => Promise.resolve());
  const store: LayoutStore = { cached: () => null, load: () => Promise.resolve({ desktop: null, mobile: null } satisfies PageLayoutsResponse), save };
  return { store, save };
}

const order = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId!);
const frame = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)!;
const handle = (title: string): HTMLElement => screen.getByRole('button', { name: `Drag ${title}` });

let elementUnderPointer: Element | null = null;

// jsdom has no PointerEvent: without one the pointer id and coordinates of a fired event are lost.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal('scrollBy', vi.fn());
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(min-width: 768px)', media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  elementUnderPointer = null;
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => elementUnderPointer });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.dataset.cardId ? WIDTH_PX[this.dataset.width!]! : 1000;
    return { left: 0, top: 0, width, height: 100, right: width, bottom: 100, x: 0, y: 0, toJSON: () => ({}) };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'elementFromPoint');
});

async function setup(store: LayoutStore) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LayoutStoreProvider store={store}>
        <CardGrid pageId="dashboard" cards={cards} />
      </LayoutStoreProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Customize layout' }));
}

const press = (title: string) => fireEvent.pointerDown(handle(title), { button: 0, pointerId: 1, clientX: 5, clientY: 5 });

describe('dragging cards', () => {
  it('drops a card after another one and saves the new order', async () => {
    const { store, save } = memoryStore();
    await setup(store);
    press('Alpha');
    elementUnderPointer = frame('c');
    fireEvent.pointerMove(handle('Alpha'), { pointerId: 1, clientX: 400, clientY: 5 });
    // Over the right half of the half-width card: it lands after it, and the card shows where.
    await waitFor(() => expect(frame('c').className).toContain('after:'));
    expect(frame('a').className).toContain('opacity-60');
    fireEvent.pointerUp(handle('Alpha'), { pointerId: 1 });
    expect(order()).toEqual(['b', 'c', 'a']);
    expect(frame('c').className).not.toContain('after:');
    await waitFor(() => expect(save).toHaveBeenCalledWith('dashboard', 'desktop', expect.objectContaining({ order: ['b', 'c', 'a'] })));
  });

  it('drops before a card when the pointer is on its first half, and stacked cards use the vertical axis', async () => {
    const { store } = memoryStore();
    await setup(store);
    press('Gamma');
    elementUnderPointer = frame('b');
    fireEvent.pointerMove(handle('Gamma'), { pointerId: 1, clientX: 10, clientY: 5 });
    await waitFor(() => expect(frame('b').className).toContain('before:-left-2'));
    fireEvent.pointerUp(handle('Gamma'), { pointerId: 1 });
    expect(order()).toEqual(['a', 'c', 'b']);

    press('Beta');
    elementUnderPointer = frame('a');
    fireEvent.pointerMove(handle('Beta'), { pointerId: 1, clientX: 10, clientY: 10 });
    await waitFor(() => expect(frame('a').className).toContain('before:-top-2'));
    elementUnderPointer = frame('a');
    fireEvent.pointerMove(handle('Beta'), { pointerId: 1, clientX: 10, clientY: 80 });
    await waitFor(() => expect(frame('a').className).toContain('after:-bottom-2'));
    fireEvent.pointerUp(handle('Beta'), { pointerId: 1 });
    expect(order()).toEqual(['a', 'b', 'c']);
  });

  it('keeps the last target over a gap, loses it outside the list and ignores the card itself', async () => {
    const { store, save } = memoryStore();
    await setup(store);
    press('Alpha');
    elementUnderPointer = frame('b');
    fireEvent.pointerMove(handle('Alpha'), { pointerId: 1, clientX: 10, clientY: 5 });
    await waitFor(() => expect(frame('b').className).toContain('before:'));

    elementUnderPointer = document.querySelector('[data-card-list]');
    fireEvent.pointerMove(handle('Alpha'), { pointerId: 1, clientX: 10, clientY: 6 });
    expect(frame('b').className).toContain('before:');

    elementUnderPointer = frame('a');
    fireEvent.pointerMove(handle('Alpha'), { pointerId: 1, clientX: 10, clientY: 7 });
    await waitFor(() => expect(frame('b').className).not.toContain('before:'));

    elementUnderPointer = document.body;
    fireEvent.pointerMove(handle('Alpha'), { pointerId: 1, clientX: 10, clientY: 8 });
    fireEvent.pointerUp(handle('Alpha'), { pointerId: 1 });
    expect(order()).toEqual(['a', 'b', 'c']);
    expect(save).not.toHaveBeenCalled();
  });

  it('cancels with Escape, a cancelled pointer or a lost capture, and ignores other pointers and buttons', async () => {
    const { store } = memoryStore();
    await setup(store);

    press('Alpha');
    expect(frame('a').className).toContain('opacity-60');
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(frame('a').className).toContain('opacity-60');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(frame('a').className).not.toContain('opacity-60');

    press('Alpha');
    fireEvent.pointerCancel(handle('Alpha'), { pointerId: 1 });
    expect(frame('a').className).not.toContain('opacity-60');

    press('Alpha');
    fireEvent.lostPointerCapture(handle('Alpha'), { pointerId: 1 });
    expect(frame('a').className).not.toContain('opacity-60');

    fireEvent.pointerDown(handle('Alpha'), { button: 2, pointerId: 1 });
    expect(frame('a').className).not.toContain('opacity-60');

    press('Alpha');
    elementUnderPointer = frame('c');
    fireEvent.pointerMove(handle('Alpha'), { pointerId: 2, clientX: 400, clientY: 5 });
    fireEvent.pointerUp(handle('Alpha'), { pointerId: 2 });
    expect(frame('a').className).toContain('opacity-60');
    fireEvent.pointerUp(handle('Alpha'), { pointerId: 1 });
    expect(order()).toEqual(['a', 'b', 'c']);
  });

  it('scrolls the page while the pointer is near the edge of the window', async () => {
    const { store } = memoryStore();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    await setup(store);

    fireEvent.pointerDown(handle('Alpha'), { button: 0, pointerId: 1, clientX: 5, clientY: 0 });
    elementUnderPointer = frame('b');
    act(() => frames.shift()!(0));
    expect(scrollBy).toHaveBeenCalledWith(0, -AUTO_SCROLL_MAX_STEP);
    expect(frames).toHaveLength(1);

    fireEvent.pointerMove(handle('Alpha'), { pointerId: 1, clientX: 5, clientY: 400 });
    act(() => frames.shift()!(0));
    expect(scrollBy).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(handle('Alpha'), { pointerId: 1 });
  });
});
