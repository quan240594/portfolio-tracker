import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

type NavItem = { to: string; label: string; end?: boolean };
type WithScope = (to: string) => string;

const DASHBOARD: NavItem = { to: '/', label: 'Dashboard', end: true };
const ANALYTICS: NavItem = { to: '/analytics', label: 'Analytics' };
export const PORTFOLIO_MENU_LABEL = 'Portfolio';
export const PORTFOLIO_ITEMS: readonly NavItem[] = [
  { to: '/holdings', label: 'Holdings' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/dividends', label: 'Dividends' },
  { to: '/rebalance', label: 'Rebalance' },
  { to: '/assets', label: 'Assets' },
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/goals', label: 'Goals' },
  { to: '/calendar', label: 'Calendar' },
  { to: '/brokers', label: 'Brokers' },
];

const ITEM_BASE =
  'flex min-h-11 items-center rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors sm:min-h-0';
const ITEM_ACTIVE = 'bg-brand-50 text-brand-700 dark:bg-brand-600/20 dark:text-brand-100';
const ITEM_IDLE =
  'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white';

const itemClass = (active: boolean) => `${ITEM_BASE} ${active ? ITEM_ACTIVE : ITEM_IDLE}`;

function NavItemLink({ item, withScope, onNavigate }: Readonly<{ item: NavItem; withScope: WithScope; onNavigate?: () => void }>) {
  return (
    <NavLink to={withScope(item.to)} end={item.end} onClick={onNavigate} className={({ isActive }) => itemClass(isActive)}>
      {item.label}
    </NavLink>
  );
}

/** True when the pathname is the item's route or nested below it (e.g. `/assets/AAPL` for `/assets`). */
const isWithin = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

/**
 * Disclosure navigation: a native button toggles a list of links. Closes on navigation, Escape
 * (focus returns to the button), pointer presses outside and focus moving outside.
 */
function PortfolioMenu({ withScope }: Readonly<{ withScope: WithScope }>) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLLIElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const active = PORTFOLIO_ITEMS.some((item) => isWithin(pathname, item.to));

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onOutside = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('focusin', onOutside);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
    };
  }, [open]);

  const idleClass = open ? `${ITEM_IDLE} bg-slate-100 dark:bg-slate-800` : ITEM_IDLE;
  const triggerClass = active ? ITEM_ACTIVE : idleClass;
  const chevronClass = open ? 'h-4 w-4 rotate-180 transition-transform' : 'h-4 w-4 transition-transform';
  return (
    <li ref={rootRef} className="static sm:relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        data-active={active || undefined}
        onClick={() => setOpen((v) => !v)}
        className={`${ITEM_BASE} w-full gap-1 ${triggerClass}`}
      >
        <span>{PORTFOLIO_MENU_LABEL}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={chevronClass}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 8l5 5 5-5" />
        </svg>
      </button>
      <ul
        id={listId}
        hidden={!open}
        className="absolute inset-x-0 top-full z-40 mt-1 grid max-h-[70vh] grid-cols-2 gap-1 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-800 dark:bg-slate-900 sm:inset-x-auto sm:left-0 sm:w-56 sm:grid-cols-1"
      >
        {PORTFOLIO_ITEMS.map((item) => (
          <li key={item.to}>
            <NavItemLink item={item} withScope={withScope} onNavigate={() => setOpen(false)} />
          </li>
        ))}
      </ul>
    </li>
  );
}

/** Header navigation: Dashboard, the Portfolio group and Analytics. */
export function MainNav({ withScope }: Readonly<{ withScope: WithScope }>) {
  return (
    <nav aria-label="Main" className="relative order-last w-full sm:order-none sm:w-auto">
      <ul className="flex flex-wrap gap-1">
        <li>
          <NavItemLink item={DASHBOARD} withScope={withScope} />
        </li>
        <PortfolioMenu withScope={withScope} />
        <li>
          <NavItemLink item={ANALYTICS} withScope={withScope} />
        </li>
      </ul>
    </nav>
  );
}
