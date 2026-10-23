import { SubrequestBudget } from './subrequests.js';
import { createLogoRoute, guardJob, type BudgetGuard, type Logger, type LogoService, type LogoSubject, type PortableRequest, type PortableResponse } from '@portfolio/platform';
import type { Deps } from '@portfolio/api';
import { isT212Ticker, resolveLogoDomain } from '@portfolio/shared';

/** Outbound calls one logo lookup may make: four sources at most, with room for the redirects the domain sources follow. */
export const LOGO_SUBREQUEST_CEILING = 8;
/** The name the budget guard knows logo lookups by: a convenience, so it gives way first (`guardJob` stops it at the warning threshold). */
export const LOGO_JOB_NAME = 'fetchLogo';

/**
 * What to look a symbol's logo up by: the Trading 212 ticker of the stored profile, and the domain (the owner's override, the website
 * of the stored provider profile, the curated ticker table, the ETF issuer prefix, see `resolveLogoDomain`). An owner's domain
 * override is an explicit choice, so it wins over the ticker. Two rows are read: the override and the profile.
 */
export function createLogoSubjectResolver(deps: Pick<Deps, 'repo' | 'mgmt'>): (userId: string, symbol: string) => Promise<LogoSubject | undefined> {
  return async (userId, symbol) => {
    const [overrides, profiles] = await Promise.all([deps.mgmt.getClassificationOverrides(userId, [symbol]), deps.repo.getProfiles([symbol])]);
    const override = overrides[symbol];
    const profile = profiles[symbol];
    const domain = resolveLogoDomain({ symbol, name: override?.name ?? profile?.name, override: override?.domain, website: profile?.website })?.domain;
    const ticker = profile?.t212Ticker;
    const t212Ticker = override?.domain === undefined && isT212Ticker(ticker) ? ticker : undefined;
    if (domain === undefined && t212Ticker === undefined) return undefined;
    return { ...(domain === undefined ? {} : { domain }), ...(t212Ticker === undefined ? {} : { t212Ticker }) };
  };
}

export interface HubLogoOptions {
  service: LogoService;
  deps: Pick<Deps, 'repo' | 'mgmt'>;
  fetch: typeof fetch;
}

/** `GET /api/logos/{symbol}` of the Hub: every lookup gets its own counted `fetch`, so one request can never pass the subrequest limit. */
export function createHubLogoRoute({ service, deps, fetch: fetchImpl }: HubLogoOptions): (request: PortableRequest) => Promise<PortableResponse> | undefined {
  return createLogoRoute({
    service,
    resolveSubject: createLogoSubjectResolver(deps),
    fetchFor: () => new SubrequestBudget(LOGO_SUBREQUEST_CEILING).wrap(fetchImpl),
  });
}

/** The lookup gate of the Hub's logo service: the budget guard's job decision (a lookup is a non-essential job). */
export function logoLookupGate(guard: BudgetGuard, logger?: Logger): () => Promise<boolean> {
  return async () => {
    const decision = await guardJob(guard, LOGO_JOB_NAME);
    if (!decision.allowed) logger?.info('Logo lookup deferred by the usage budget', { reason: decision.reason });
    return decision.allowed;
  };
}
