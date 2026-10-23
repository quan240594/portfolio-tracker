import { useRef } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTheme } from '../theme/ThemeProvider';
import { MainNav } from './MainNav';
import { DemoBanner } from './DemoBanner';
import { useStickyOffset } from './useStickyOffset';
import { USE_MOCKS } from '../config';
import { useEarningsStatus } from '../api/earningsHooks';
import { AccountMenu } from '../features/auth/AccountMenu';
import { UsageBanner } from '../features/usage/UsageBanner';
import { UsageIndicator } from '../features/usage/UsageIndicator';
import { PortfolioSwitcher } from '../features/portfolios/PortfolioSwitcher';
import { usePortfolioScope, usePortfolioScopeSync } from '../features/portfolios/usePortfolioScope';

function Logo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className="h-8 w-8">
      <rect width="32" height="32" rx="8" className="fill-brand-600" />
      <path d="M7 22l6-7 5 4 7-9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-pressed={isDark}
      aria-label="Dark mode"
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {isDark ? (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
        </svg>
      ) : (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-slate-200 py-6 text-xs dark:border-slate-800">
      <div className="muted mx-auto max-w-7xl px-4 sm:px-6">
        <p>
          Market data: Twelve Data, EODHD,{' '}
          <a href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-brand-600">
            CoinGecko
          </a>, ECB via Frankfurter. Prices may be delayed. Not investment advice.
        </p>
      </div>
    </footer>
  );
}

export function Layout() {
  usePortfolioScopeSync();
  const { withScope } = usePortfolioScope();
  const stickyRef = useRef<HTMLDivElement>(null);
  useStickyOffset(stickyRef);
  const earnings = useEarningsStatus();
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:shadow dark:focus:bg-slate-900">
        Skip to content
      </a>
      {/* From sm up the banner and the header are one sticky unit; below sm the wrapper vanishes (`contents`) and only the
          banner is pinned (it is sticky itself), so the header scrolls away. useStickyOffset feeds scroll-padding-top. */}
      <div ref={stickyRef} className="contents sm:sticky sm:top-0 sm:z-30 sm:block">
        {USE_MOCKS && <DemoBanner />}
        <header className="border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
            <NavLink to={withScope('/')} className="flex items-center gap-2 font-semibold tracking-tight">
              <Logo />
              <span>Portfolio Tracker</span>
            </NavLink>
            <div className="ml-auto flex min-w-0 items-center gap-2 sm:order-last">
              <PortfolioSwitcher />
              <ThemeToggle />
              <AccountMenu />
              <UsageIndicator />
            </div>
            <MainNav withScope={withScope} earnings={earnings.data?.available === true} />
          </div>
        </header>
      </div>
      <UsageBanner />
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus:outline-none sm:px-6">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

export function PageHeader({ title, description, actions }: Readonly<{ title: string; description?: string; actions?: React.ReactNode }>) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="muted mt-1 text-sm">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
