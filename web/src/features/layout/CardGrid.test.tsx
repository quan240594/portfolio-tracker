import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LayoutBreakpoint, LayoutPageId, PageLayout, PageLayoutsResponse } from '@portfolio/shared';
import { CardGrid, type CardDefinition } from './CardGrid';
import { LayoutStoreProvider, type LayoutStore } from './layoutStore';
import { SAVE_DEBOUNCE_MS } from './useCardLayout';

const DESKTOP = '(min-width: 768px)';

function stubViewport(desktop: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: desktop && query === DESKTOP,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function memoryStore(initial: Partial<PageLayoutsResponse> = {}, cached: PageLayoutsResponse | null = null) {
  let data: PageLayoutsResponse = { desktop: null, mobile: null, ...initial };
  const save = vi.fn((_page: LayoutPageId, breakpoint: LayoutBreakpoint, layout: PageLayout | null) => {
    data = { ...data, [breakpoint]: layout };
    return Promise.resolve();
  });
  const store: LayoutStore = { cached: () => cached, load: () => Promise.resolve(data), save };
  return { store, save };
}

const renders = { a: vi.fn(), b: vi.fn(), c: vi.fn(), d: vi.fn() };
const cards: CardDefinition[] = [
  { id: 'a', title: 'Alpha', defaultWidth: 'full', render: () => { renders.a(); return <p>Alpha body</p>; } },
  { id: 'b', title: 'Beta', defaultWidth: 'half', render: () => { renders.b(); return <p>Beta body</p>; } },
  { id: 'c', title: 'Gamma', defaultWidth: 'half', render: () => { renders.c(); return <p>Gamma body</p>; } },
  { id: 'd', title: 'Delta', defaultWidth: 'third', render: () => { renders.d(); return <p>Delta body</p>; } },
];

function setup(store: LayoutStore, props: { cards?: CardDefinition[]; emptyHint?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (list: CardDefinition[]) => (
    <QueryClientProvider client={queryClient}>
      <LayoutStoreProvider store={store}>
        <CardGrid pageId="dashboard" cards={list} emptyHint={props.emptyHint} />
      </LayoutStoreProvider>
    </QueryClientProvider>
  );
  const view = render(tree(props.cards ?? cards));
  return { ...view, rerenderWith: (list: CardDefinition[]) => view.rerender(tree(list)) };
}

const order = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId!);
const customize = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Customize layout' }));
const stored = (overrides: Partial<PageLayout>): PageLayout => ({ version: 1, breakpoint: 'desktop', order: [], widths: {}, hidden: [], ...overrides });

beforeEach(() => {
  stubViewport(true);
  for (const spy of Object.values(renders)) spy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('CardGrid', () => {
  it('shows the cards in the default order, with no controls until customizing', async () => {
    const { store } = memoryStore();
    setup(store);
    expect(await screen.findByText('Alpha body')).toBeInTheDocument();
    expect(order()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.queryByRole('button', { name: /^Move/ })).not.toBeInTheDocument();
    expect(document.querySelector('[data-card-id="b"]')).toHaveClass('md:col-span-6');

    const user = userEvent.setup();
    await customize(user);
    expect(screen.getByText('Editing the layout for wide screens')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: /^Move/ })).not.toBeInTheDocument();
  });

  it('moves cards with the keyboard, keeps focus and announces the new place', async () => {
    const { store, save } = memoryStore();
    setup(store);
    const user = userEvent.setup();
    await customize(user);
    expect(screen.getByRole('button', { name: 'Move Alpha up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Delta down' })).toBeDisabled();

    const down = screen.getByRole('button', { name: 'Move Alpha down' });
    down.focus();
    await user.keyboard('{Enter}');
    expect(order()).toEqual(['b', 'a', 'c', 'd']);
    expect(down).toHaveFocus();
    expect(screen.getByText('Alpha is now card 2 of 4')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(order()).toEqual(['b', 'c', 'a', 'd']);
    await user.click(screen.getByRole('button', { name: 'Move Delta up' }));
    expect(order()).toEqual(['b', 'c', 'd', 'a']);

    // Three edits, one request.
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: SAVE_DEBOUNCE_MS * 4 });
    expect(save).toHaveBeenCalledWith('dashboard', 'desktop', stored({ order: ['b', 'c', 'd', 'a'] }));
    await waitFor(() => expect(screen.queryByText('Saving…')).not.toBeInTheDocument());
  });

  it('changes a card width and stores only what differs from the default', async () => {
    const { store, save } = memoryStore();
    setup(store);
    const user = userEvent.setup();
    await customize(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Width of Beta' }), 'full');
    expect(document.querySelector('[data-card-id="b"]')).toHaveClass('md:col-span-12');
    expect(screen.getByText('Beta is now full width')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Width of Delta' }), 'half');
    await waitFor(() => expect(save).toHaveBeenCalled(), { timeout: SAVE_DEBOUNCE_MS * 4 });
    expect(save).toHaveBeenLastCalledWith('dashboard', 'desktop', stored({ widths: { b: 'full', d: 'half' } }));
    // Back to the default width of both: nothing left to store.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Width of Beta' }), 'half');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Width of Delta' }), 'third');
    await waitFor(() => expect(save).toHaveBeenLastCalledWith('dashboard', 'desktop', null), { timeout: SAVE_DEBOUNCE_MS * 4 });
  });

  it('hides a card (without rendering it) and shows it again in its place', async () => {
    const { store, save } = memoryStore();
    setup(store);
    const user = userEvent.setup();
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Hide Beta' }));
    expect(order()).toEqual(['a', 'c', 'd']);
    expect(screen.queryByText('Beta body')).not.toBeInTheDocument();
    expect(screen.getByText('Beta is hidden')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();

    const hiddenList = screen.getByRole('region', { name: 'Hidden cards' });
    await user.click(within(hiddenList).getByRole('button', { name: 'Show Beta' }));
    expect(order()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.queryByRole('region', { name: 'Hidden cards' })).not.toBeInTheDocument();
    expect(screen.getByText('Beta is shown again')).toBeInTheDocument();
    await waitFor(() => expect(save).toHaveBeenCalled(), { timeout: SAVE_DEBOUNCE_MS * 4 });
    expect(save).toHaveBeenLastCalledWith('dashboard', 'desktop', null);
  });

  it('says so when every card is hidden', async () => {
    const { store } = memoryStore({ desktop: stored({ hidden: ['a', 'b', 'c', 'd'] }) });
    setup(store);
    expect(await screen.findByText(/Every card is hidden/)).toBeInTheDocument();
    expect(screen.queryByText('Alpha body')).not.toBeInTheDocument();
  });

  it('shows a custom hint when every card is hidden', async () => {
    const { store } = memoryStore({ desktop: stored({ hidden: ['a', 'b', 'c', 'd'] }) });
    setup(store, { emptyHint: 'Nothing here' });
    expect(await screen.findByText('Nothing here')).toBeInTheDocument();
  });

  it('applies the stored layout and falls back to the default for unknown and new cards', async () => {
    const { store } = memoryStore({ desktop: stored({ order: ['d', 'gone', 'b'], widths: { d: 'full', gone: 'half' }, hidden: ['c', 'gone'] }) });
    const { rerenderWith } = setup(store);
    await waitFor(() => expect(order()).toEqual(['a', 'd', 'b']));
    expect(document.querySelector('[data-card-id="d"]')).toHaveClass('md:col-span-12');

    // A card added to the page later shows at its default place; the saved layout keeps working.
    rerenderWith([...cards, { id: 'e', title: 'Epsilon', defaultWidth: 'full', render: () => <p>Epsilon body</p> }]);
    await waitFor(() => expect(order()).toEqual(['a', 'd', 'e', 'b']));
  });

  it('shows this browser\u2019s last copy while the stored layout loads', async () => {
    const { store } = memoryStore({}, { desktop: stored({ order: ['b', 'a', 'c', 'd'] }), mobile: null });
    setup(store);
    expect(order()).toEqual(['b', 'a', 'c', 'd']);
    await waitFor(() => expect(order()).toEqual(['a', 'b', 'c', 'd']));
  });

  it('resets to the default and clears what was stored', async () => {
    const { store, save } = memoryStore({ desktop: stored({ order: ['d', 'a', 'b', 'c'] }) });
    setup(store);
    const user = userEvent.setup();
    await waitFor(() => expect(order()).toEqual(['d', 'a', 'b', 'c']));
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(order()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.getByText('Layout reset to the default')).toBeInTheDocument();
    await waitFor(() => expect(save).toHaveBeenCalledWith('dashboard', 'desktop', null));
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  });

  it('edits the mobile layout on a narrow screen, without width choices', async () => {
    stubViewport(false);
    const { store, save } = memoryStore({ desktop: stored({ order: ['d', 'a', 'b', 'c'] }) });
    setup(store);
    const user = userEvent.setup();
    await screen.findByText('Alpha body');
    expect(order()).toEqual(['a', 'b', 'c', 'd']);
    await customize(user);
    expect(screen.getByText('Editing the layout for narrow screens')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move Beta up' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('dashboard', 'mobile', stored({ breakpoint: 'mobile', order: ['b', 'a', 'c', 'd'] })));
  });

  it('saves pending edits when the page is left', async () => {
    const { store, save } = memoryStore();
    const { unmount } = setup(store);
    const user = userEvent.setup();
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Hide Delta' }));
    expect(save).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(save).toHaveBeenCalledWith('dashboard', 'desktop', stored({ hidden: ['d'] })));
  });

  it('reports a failed save and sends it again on request', async () => {
    const { store, save } = memoryStore();
    save.mockRejectedValueOnce(new Error('Server says no'));
    setup(store);
    const user = userEvent.setup();
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Hide Delta' }));
    expect(await screen.findByRole('alert', {}, { timeout: SAVE_DEBOUNCE_MS * 8 })).toHaveTextContent('Could not save the layout: Server says no.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('dashboard', 'desktop', stored({ hidden: ['d'] }));
  });

  it('keeps a newer edit when an older save fails', async () => {
    const { store, save } = memoryStore();
    let failFirst: (error: Error) => void = () => {};
    save.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          failFirst = reject;
        }),
    );
    setup(store);
    const user = userEvent.setup();
    await customize(user);
    await user.click(screen.getByRole('button', { name: 'Hide Delta' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: SAVE_DEBOUNCE_MS * 4 });
    await user.click(screen.getByRole('button', { name: 'Hide Gamma' }));
    failFirst(new Error('Server says no'));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith('dashboard', 'desktop', stored({ hidden: ['c', 'd'] }));
  });
});
