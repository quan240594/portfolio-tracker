import { Suspense, lazy, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider, useLocation, type RouteObject } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { HoldingsPage } from './pages/HoldingsPage';
import { DividendsPage } from './pages/DividendsPage';
import { TransactionsPage } from './pages/TransactionsPage';
import { RebalancePage } from './pages/RebalancePage';
import { AssetsPage } from './pages/AssetsPage';
import { WatchlistPage } from './pages/WatchlistPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { LoadingRegion, Skeleton } from './components/Skeleton';
import { BrokerPage } from './features/broker/BrokerPage';
import { ApiError } from './api/client';
import { routerBasename } from './config';
import { AuthGate } from './features/auth/AuthGate';
import { AuthProvider } from './features/auth/AuthProvider';

// Charts and calculators of the analytics page stay out of the main bundle until it is visited.
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const GoalsPage = lazy(() => import('./pages/GoalsPage'));
const CalendarPage = lazy(() => import('./pages/CalendarPage').then((m) => ({ default: m.CalendarPage })));
const AssetDetailPage = lazy(() => import('./pages/AssetDetailPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const DiagnosticsPage = lazy(() => import('./pages/DiagnosticsPage'));

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/holdings': 'Holdings',
  '/dividends': 'Dividends',
  '/calendar': 'Calendar',
  '/transactions': 'Transactions',
  '/analytics': 'Analytics',
  '/goals': 'Goals',
  '/rebalance': 'Rebalance',
  '/assets': 'Assets',
  '/watchlist': 'Watchlist',
  '/brokers': 'Trading 212',
  '/settings/notifications': 'Notifications',
  '/settings/diagnostics': 'Diagnostics',
};

const ASSET_DETAIL_PREFIX = '/assets/';

/** Title of a route: `/assets/<symbol>` shows the (decoded) symbol, unknown paths are "Not found". */
export function titleFor(pathname: string): string {
  if (pathname.startsWith(ASSET_DETAIL_PREFIX) && pathname.length > ASSET_DETAIL_PREFIX.length) {
    try {
      return `${decodeURIComponent(pathname.slice(ASSET_DETAIL_PREFIX.length))} · Asset detail`;
    } catch {
      return 'Asset detail';
    }
  }
  return TITLES[pathname] ?? 'Not found';
}

/** Updates the document title and moves focus to <main> on navigation (screen-reader friendly). */
function RouteAnnouncer() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = `${titleFor(pathname)} · Portfolio Tracker`;
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
      {
        path: 'calendar',
        element: (
          <Suspense fallback={<LoadingRegion label="Loading calendar"><Skeleton className="h-96 w-full" /></LoadingRegion>}>
            <CalendarPage />
          </Suspense>
        ),
      },
      { path: 'transactions', element: <TransactionsPage /> },
      {
        path: 'analytics',
        element: (
          <Suspense fallback={<LoadingRegion label="Loading analytics"><Skeleton className="h-96 w-full" /></LoadingRegion>}>
            <AnalyticsPage />
          </Suspense>
        ),
      },
      {
        path: 'goals',
        element: (
          <Suspense fallback={<LoadingRegion label="Loading goals"><Skeleton className="h-96 w-full" /></LoadingRegion>}>
            <GoalsPage />
          </Suspense>
        ),
      },
      { path: 'rebalance', element: <RebalancePage /> },
      { path: 'assets', element: <AssetsPage /> },
      {
        path: 'assets/:symbol',
        element: (
          <Suspense fallback={<LoadingRegion label="Loading security"><Skeleton className="h-96 w-full" /></LoadingRegion>}>
            <AssetDetailPage />
          </Suspense>
        ),
      },
      { path: 'watchlist', element: <WatchlistPage /> },
      { path: 'brokers', element: <BrokerPage /> },
      {
        path: 'settings/notifications',
        element: (
          <Suspense fallback={<LoadingRegion label="Loading notifications"><Skeleton className="h-64 w-full" /></LoadingRegion>}>
            <NotificationsPage />
          </Suspense>
        ),
      },
      {
        path: 'settings/diagnostics',
        element: (
          <Suspense fallback={<LoadingRegion label="Loading diagnostics"><Skeleton className="h-64 w-full" /></LoadingRegion>}>
            <DiagnosticsPage />
          </Suspense>
        ),
      },
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
