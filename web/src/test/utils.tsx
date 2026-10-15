import type { ReactElement, ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { ThemeProvider } from '../theme/ThemeProvider';
import { routes, ROUTER_FUTURE } from '../App';
import { PORTFOLIO_ITEMS, PORTFOLIO_MENU_LABEL } from '../components/MainNav';

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const queryClient = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]} future={ROUTER_FUTURE}>{children}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
  return { queryClient, ...render(ui, { wrapper: Wrapper }) };
}

export function renderApp(route = '/', { basename }: { basename?: string } = {}) {
  const queryClient = createTestQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [route], basename, future: ROUTER_FUTURE });
  return {
    queryClient,
    router,
    ...render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </QueryClientProvider>
      </ThemeProvider>,
    ),
  };
}

/** Intl separates currency symbols with a no-break space; DOM text matchers normalise it to a plain space. */
export const sp = (s: string) => s.replace(/\u00a0/g, ' ');

export const mainNav = () => screen.getByRole('navigation', { name: 'Main' });

/** Opens the header's Portfolio menu (no-op when it is already open) and returns the trigger button. */
export async function openPortfolioMenu(user: UserEvent) {
  const trigger = within(mainNav()).getByRole('button', { name: PORTFOLIO_MENU_LABEL });
  if (trigger.getAttribute('aria-expanded') !== 'true') await user.click(trigger);
  return trigger;
}

/** Clicks a header navigation link, opening the Portfolio menu first when the link lives in it. */
export async function gotoViaNav(user: UserEvent, label: string) {
  if (PORTFOLIO_ITEMS.some((item) => item.label === label)) await openPortfolioMenu(user);
  await user.click(within(mainNav()).getByRole('link', { name: label }));
}
