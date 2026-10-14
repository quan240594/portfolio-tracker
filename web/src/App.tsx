import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider, useLocation, type RouteObject } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { HoldingsPage } from './pages/HoldingsPage';
import { DividendsPage } from './pages/DividendsPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ApiError } from './api/client';
import { routerBasename } from './config';
import { AuthGate } from './features/auth/AuthGate';
import { AuthProvider } from './features/auth/AuthProvider';

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/holdings': 'Holdings',
  '/dividends': 'Dividends',
  '/transactions': 'Transactions',
};

/** Updates the document title and moves focus to <main> on navigation (screen-reader friendly). */
function RouteAnnouncer() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = `${TITLES[pathname] ?? 'Not found'} · Portfolio Tracker`;
  }, [pathname]);
  useEffect(() => {
    const main = document.getElementById('main');
    if (main && document.activeElement !== document.body) main.focus({ preventScroll: true });
  }, [pathname]);
  return null;
}

function Root() {
  return (
    <AuthGate>
      <RouteAnnouncer />
      <Layout />
    </AuthGate>
  );
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Root />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'holdings', element: <HoldingsPage /> },
      { path: 'dividends', element: <DividendsPage /> },
      { path: 'transactions', element: <TransactionsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Don't retry client errors (4xx); retry transient failures twice.
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  });
}

export const ROUTER_FUTURE = {
  v7_startTransition: true,
  v7_relativeSplatPath: true,
  v7_fetcherPersist: true,
  v7_normalizeFormMethod: true,
  v7_partialHydration: true,
  v7_skipActionErrorRevalidation: true,
} as const;

const router = createBrowserRouter(routes, { future: ROUTER_FUTURE, basename: routerBasename() });
const queryClient = createQueryClient();

export function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
