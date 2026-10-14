import { NavLink, Outlet } from 'react-router-dom';
import { useTheme } from '../theme/ThemeProvider';
import { USE_MOCKS } from '../config';
import { PortfolioSwitcher } from '../features/portfolios/PortfolioSwitcher';
import { usePortfolioScope, usePortfolioScopeSync } from '../features/portfolios/usePortfolioScope';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/holdings', label: 'Holdings' },
  { to: '/dividends', label: 'Dividends' },
  { to: '/transactions', label: 'Transactions' },
];

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
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:shadow dark:focus:bg-slate-900">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <NavLink to={withScope('/')} className="flex items-center gap-2 font-semibold tracking-tight">
            <Logo />
            <span>Portfolio Tracker</span>
          </NavLink>
          {USE_MOCKS && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              Demo data
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 sm:order-last">
            <PortfolioSwitcher />
            <ThemeToggle />
          </div>
          <nav aria-label="Main" className="order-last w-full overflow-x-auto sm:order-none sm:w-auto">
            <ul className="flex gap-1">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={withScope(item.to)}
                    end={item.end}
                    className={({ isActive }) =>
                      `block rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${
                        isActive
                          ? 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
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
