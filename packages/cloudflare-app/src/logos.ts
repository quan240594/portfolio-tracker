import { SubrequestBudget } from './subrequests.js';
import { createLogoRoute, guardJob, type BudgetGuard, type Logger, type LogoService, type PortableRequest, type PortableResponse } from '@portfolio/platform';
import type { Deps } from '@portfolio/api';
import { resolveLogoDomain } from '@portfolio/shared';

/** Outbound calls one logo lookup may make: three sources at most, with room for the redirect a source follows. */
export const LOGO_SUBREQUEST_CEILING = 8;
/** The name the budget guard knows logo lookups by: a convenience, so it gives way first (`guardJob` stops it at the warning threshold). */
export const LOGO_JOB_NAME = 'fetchLogo';

/**
 * The domain to look a symbol's logo up by: the owner's override, the website of the stored provider profile, the curated
 * ticker table, the ETF issuer prefix (see `resolveLogoDomain`). Two rows are read: the override and the profile.
 */
export function createLogoDomainResolver(deps: Pick<Deps, 'repo' | 'mgmt'>): (userId: string, symbol: string) => Promise<string | undefined> {
  return async (userId, symbol) => {
    const [overrides, profiles] = await Promise.all([deps.mgmt.getClassificationOverrides(userId, [symbol]), deps.repo.getProfiles([symbol])]);
    const override = overrides[symbol];
    const profile = profiles[symbol];
    return resolveLogoDomain({ symbol, name: override?.name ?? profile?.name, override: override?.domain, website: profile?.website })?.domain;
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
    resolveDomain: createLogoDomainResolver(deps),
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
