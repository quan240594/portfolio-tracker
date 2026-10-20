import { applyClassificationOverrides, classificationFieldsOf, type InstrumentProfile } from '@portfolio/shared';
import type { RouteContext } from '../deps.js';

/**
 * The profiles of `symbols` as the user sees them: the stored (provider, Trading 212 baseline or minimal) profile with the
 * user's classification overrides on top. This is the single place the profile join happens for every read endpoint, so the
 * allocation, holdings, analytics and asset detail always agree.
 */
export async function loadProfiles(ctx: RouteContext, symbols: readonly string[]): Promise<Record<string, InstrumentProfile>> {
  const { repo, mgmt } = ctx.deps;
  const wanted = [...new Set(symbols)];
  if (wanted.length === 0) return {};
  const [profiles, overrides] = await Promise.all([repo.getProfiles(wanted), mgmt.getClassificationOverrides(ctx.userId, wanted)]);
  const fields = Object.fromEntries(Object.entries(overrides).map(([symbol, item]) => [symbol, classificationFieldsOf(item)]));
  // An override of a symbol that has no stored profile yet makes one, in the currency of its quote (else the base currency).
  const bare = Object.keys(fields).filter((symbol) => profiles[symbol] === undefined);
  const quotes = bare.length === 0 ? {} : await repo.getQuotes(bare);
  const currencies = Object.fromEntries(bare.map((symbol) => [symbol, quotes[symbol]?.currency ?? ctx.deps.config.baseCurrency]));
  return applyClassificationOverrides(profiles, fields, currencies);
}
