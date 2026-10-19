import { useState } from 'react';
import { ALL_PORTFOLIOS } from '@portfolio/shared';
import { ALL_PORTFOLIOS_LABEL, usePortfolioScope } from './usePortfolioScope';
import { ManagePortfoliosDialog } from './ManagePortfoliosDialog';

/** Header control: pick one portfolio or all of them combined, and open "Manage portfolios". */
export function PortfolioSwitcher() {
  const { scope, setScope, portfolios } = usePortfolioScope();
  const [manageOpen, setManageOpen] = useState(false);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor="portfolio-switcher" className="muted text-sm whitespace-nowrap">
        Scope
      </label>
      <select
        id="portfolio-switcher"
        className="input w-auto min-w-0 max-w-[14rem] py-1.5"
        value={scope}
        onChange={(e) => setScope(e.target.value)}
      >
        <option value={ALL_PORTFOLIOS}>{ALL_PORTFOLIOS_LABEL}</option>
        {portfolios?.map((p) => (
          <option key={p.portfolioId} value={p.portfolioId}>
            {p.name}
          </option>
        ))}
        {!portfolios && scope !== ALL_PORTFOLIOS && <option value={scope}>Loading…</option>}
      </select>
      <button
        type="button"
        className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label="Manage portfolios"
        title="Manage portfolios"
        aria-haspopup="dialog"
        onClick={() => setManageOpen(true)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 6h10M4 12h6M4 18h10M17 4v4M15 6h4M14 12h6M17 16v4M15 18h4" strokeLinecap="round" />
        </svg>
      </button>
      <ManagePortfoliosDialog open={manageOpen} onClose={() => setManageOpen(false)} />
    </div>
  );
}
