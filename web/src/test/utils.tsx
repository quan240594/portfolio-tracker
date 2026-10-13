import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import { ThemeProvider } from '../theme/ThemeProvider';
import { routes, ROUTER_FUTURE } from '../App';

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
