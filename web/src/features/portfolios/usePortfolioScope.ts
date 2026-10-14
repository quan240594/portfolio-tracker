import { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ALL_PORTFOLIOS, DEFAULT_PORTFOLIO_ID, portfolioIdSchema, type Portfolio } from '@portfolio/shared';
import { usePortfolios } from '../../api/hooks';
import type { Scope } from '../../api/client';

/** URL search param holding the selected scope (`all` or a portfolio id). */
export const PORTFOLIO_PARAM = 'portfolio';
export const PORTFOLIO_STORAGE_KEY = 'pt-portfolio';
export const ALL_PORTFOLIOS_LABEL = 'All portfolios';

const isScope = (v: string | null): v is Scope => !!v && (v === ALL_PORTFOLIOS || portfolioIdSchema.safeParse(v).success);

export function readStoredScope(): Scope | null {
  try {
    const v = localStorage.getItem(PORTFOLIO_STORAGE_KEY);
    return isScope(v) ? v : null;
  } catch {
    return null;
  }
}

function storeScope(scope: Scope) {
  try {
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, scope);
  } catch {
    // Storage unavailable (e.g. private mode): the URL still carries the scope.
  }
}

/** Portfolio preselected for new transactions/imports: the scoped one, else the default (or first) portfolio. */
export function defaultTargetPortfolio(scope: Scope, portfolios: readonly Portfolio[] | undefined): string {
  if (!portfolios) return scope === ALL_PORTFOLIOS ? DEFAULT_PORTFOLIO_ID : scope;
  if (portfolios.some((p) => p.portfolioId === scope)) return scope;
  return (portfolios.find((p) => p.portfolioId === DEFAULT_PORTFOLIO_ID) ?? portfolios[0])?.portfolioId ?? DEFAULT_PORTFOLIO_ID;
}

export const portfolioName = (portfolios: readonly Portfolio[] | undefined, id: string) =>
  portfolios?.find((p) => p.portfolioId === id)?.name ?? id;

/**
 * Selected portfolio scope. The source of truth is `?portfolio=` in the URL (so links and the back
 * button work); without it the last choice from localStorage is used, defaulting to all portfolios.
 * Ids that no longer exist resolve to 'all' once the portfolio list has loaded.
 */
export function usePortfolioScope() {
  const [params, setParams] = useSearchParams();
  const portfoliosQuery = usePortfolios();
  const portfolios = portfoliosQuery.data?.portfolios;

  const fromUrl = params.get(PORTFOLIO_PARAM);
  const requested: Scope = isScope(fromUrl) ? fromUrl : (readStoredScope() ?? ALL_PORTFOLIOS);
  const unknown = requested !== ALL_PORTFOLIOS && !!portfolios && !portfolios.some((p) => p.portfolioId === requested);
  const scope: Scope = unknown ? ALL_PORTFOLIOS : requested;
  const current = portfolios?.find((p) => p.portfolioId === scope);
  // A single portfolio is only queried once it is known to exist (or the list could not be loaded).
  const ready = scope === ALL_PORTFOLIOS || !!current || portfoliosQuery.isError;
  const scopeName = scope === ALL_PORTFOLIOS ? ALL_PORTFOLIOS_LABEL : (current?.name ?? '');

  const setScope = useCallback(
    (next: Scope) => {
      storeScope(next);
      setParams((p) => {
        const n = new URLSearchParams(p);
        n.set(PORTFOLIO_PARAM, next);
        return n;
      });
    },
    [setParams],
  );

  const explicit = params.has(PORTFOLIO_PARAM);
  /** Appends the scope to an in-app link when it is explicit in the URL or not the default. */
  const withScope = useCallback(
    (to: string) => {
      if (scope === ALL_PORTFOLIOS && !explicit) return to;
      return `${to}${to.includes('?') ? '&' : '?'}${PORTFOLIO_PARAM}=${encodeURIComponent(scope)}`;
    },
    [scope, explicit],
  );

  return { scope, setScope, withScope, ready, scopeName, current, portfolios, portfoliosQuery };
}

/**
 * Mounted once (in the layout): mirrors a stored scope into the URL, persists the URL scope, and drops
 * invalid or deleted ids, so the address bar always reflects what is shown.
 */
export function usePortfolioScopeSync() {
  const [params, setParams] = useSearchParams();
  const { scope } = usePortfolioScope();
  const fromUrl = params.get(PORTFOLIO_PARAM);

  useEffect(() => {
    if (fromUrl === scope) {
      storeScope(scope);
    } else if (fromUrl === null) {
      if (scope === ALL_PORTFOLIOS) storeScope(scope);
      else
        setParams(
          (p) => {
            const n = new URLSearchParams(p);
            n.set(PORTFOLIO_PARAM, scope);
            return n;
          },
          { replace: true },
        );
    } else {
      // Invalid or deleted portfolio in the URL → combined view.
      storeScope(ALL_PORTFOLIOS);
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.delete(PORTFOLIO_PARAM);
          return n;
        },
        { replace: true },
      );
    }
  }, [fromUrl, scope, setParams]);
}
