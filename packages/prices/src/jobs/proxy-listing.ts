import type { ListingMatch } from '@portfolio/platform';
import { majorCurrencyCode, proxySourceOf, isProxySource, type EodPrice, type InstrumentProfile } from '@portfolio/shared';
import { validIsin } from '../parse.js';
import { currencyFor } from '../symbols.js';
import { addDays } from '../time.js';
import type { ProxyRecord } from '../repository.js';
import type { StepContext } from './common.js';

/** The exchanges a proxy listing is taken from, in order of preference (suffixes of the app). */
export const PROXY_EXCHANGES: readonly string[] = ['DE', 'F', 'AS', 'PA', 'MI', 'L'];
/** A search that found no usable listing is not repeated for this many days. */
export const PROXY_RETRY_DAYS = 7;
/** Newest rows of the held symbol read to find the days that already have a row of their own. */
const OWN_ROWS_READ = 400;

export interface ProxyWanted {
  symbol: string;
  isin: string;
  /** Major currency of the position. */
  currency: string;
}

/** London lines are quoted in pence (`GBX`): the history of a London listing is divided by 100, so only a listing that says so can stand in for a GBP one. */
function currencyFits(listing: ListingMatch, currency: string): boolean {
  const code = listing.currency.trim();
  if (listing.exchange === 'L') return currency === 'GBP' && (code === 'GBX' || code === 'GBp');
  return code.toUpperCase() === currency;
}

/**
 * The listing whose history may stand in for the held symbol: the same ISIN (a row without one is no proof), another exchange than
 * the held one, in the currency of the position (never another currency), the most preferred exchange first.
 */
export function chooseListing(listings: readonly ListingMatch[], wanted: Readonly<ProxyWanted>): string | null {
  const fitting = listings.filter((listing) => listing.isin === wanted.isin && listing.symbol !== wanted.symbol && currencyFits(listing, wanted.currency));
  for (const exchange of PROXY_EXCHANGES) {
    const found = fitting.find((listing) => listing.exchange === exchange);
    if (found !== undefined) return found.symbol;
  }
  return null;
}

/** The stored answer for this ISIN and currency when it is still good, else undefined. */
function knownListing(record: ProxyRecord | undefined, wanted: Readonly<ProxyWanted>, today: string): string | null | undefined {
  if (record?.currency !== wanted.currency) return undefined;
  if (record.listing !== null) return record.listing;
  return record.checkedOn > addDays(today, -PROXY_RETRY_DAYS) ? null : undefined;
}

/** The listing to take the history from: the stored answer, else one search call (a rate limit propagates and is stored by the caller's block). */
async function resolveListing(ctx: StepContext, wanted: Readonly<ProxyWanted>, today: string): Promise<string | null> {
  const known = knownListing(await ctx.repo.getProxyListing(wanted.isin), wanted, today);
  if (known !== undefined) return known;
  const search = ctx.md.provider.searchListings?.bind(ctx.md.provider);
  if (search === undefined) return null;
  const listing = chooseListing(await search(wanted.isin), wanted);
  await ctx.repo.putProxyListing({ isin: wanted.isin, currency: wanted.currency, listing, checkedOn: today });
  if (listing !== null) ctx.logger.info('history from another listing of the same fund', { symbol: wanted.symbol, listing });
  return listing;
}

/** The rows of the proxy history on days the symbol has no row of its own (a provider's or the broker's, or one of the history symbol the owner set); an automatic proxy row is replaced. */
async function newDays(ctx: StepContext, symbol: string, rows: readonly EodPrice[]): Promise<EodPrice[]> {
  const own = new Set((await ctx.repo.newestEod(symbol, OWN_ROWS_READ)).filter((row) => row.override === true || !isProxySource(row.source)).map((row) => row.date));
  return rows.filter((row) => !own.has(row.date));
}

/**
 * The end-of-day history of a held symbol the provider does not know, taken from another listing of the same fund (found by ISIN)
 * and stored under the held symbol with `source: 'eodhd:<listing>'`; null when there is none (no ISIN, no such listing, no data).
 * Costs one provider call for the search (once per ISIN, the answer is stored) and one for the history.
 */
export async function proxyHistory(
  ctx: StepContext,
  symbol: string,
  profile: Readonly<InstrumentProfile> | undefined,
  today: string,
  fetchHistory: (listing: string) => Promise<EodPrice[] | null>,
): Promise<EodPrice[] | null> {
  const isin = validIsin(profile?.isin);
  if (isin === undefined) return null;
  const currency = majorCurrencyCode((profile?.currency ?? currencyFor(symbol)).toUpperCase());
  const listing = await resolveListing(ctx, { symbol, isin, currency }, today);
  if (listing === null) return null;
  const rows = await fetchHistory(listing);
  if (rows === null || rows.length === 0) return null;
  const source = proxySourceOf(listing);
  return newDays(
    ctx,
    symbol,
    rows.map((row) => ({ ...row, symbol, source })),
  );
}
