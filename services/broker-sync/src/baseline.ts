import { logger } from '@portfolio/platform';
import { mergeProfile, trading212Profile, type InstrumentProfile, type SymbolMapping } from '@portfolio/shared';
import type { ProfileStore } from './profile-store.js';
import type { OpenPosition } from './t212/schemas.js';
import type { TradableInstrument } from './t212/schemas.js';

/**
 * Baseline profiles from Trading 212: a real name, a STOCK/ETF type, the ISIN and the currency of every held symbol, with no
 * market-data key. The name, ISIN and currency come with the open positions already (no extra request); the type only comes with the
 * instruments metadata, which is loaded (at most hourly, and shared with the exchange mapping) only while a held symbol has no real
 * asset class yet. A richer profile is never degraded: `mergeProfile` lets a provider profile override the baseline field by field.
 * The country is only the ISIN prefix: the issuer's country for a share, the DOMICILE of the fund for an ETF or ETC.
 */
export interface HeldInstrument {
  symbol: string;
  instrument: OpenPosition['instrument'];
}

/** The held instruments that map to an app symbol, one per symbol. */
export function heldInstruments(items: readonly OpenPosition[], symbols: ReadonlyMap<string, SymbolMapping>): HeldInstrument[] {
  const bySymbol = new Map<string, HeldInstrument>();
  for (const { instrument } of items) {
    const mapping = symbols.get(instrument.ticker);
    if (mapping?.ok && !bySymbol.has(mapping.symbol)) bySymbol.set(mapping.symbol, { symbol: mapping.symbol, instrument });
  }
  return [...bySymbol.values()];
}

/** A profile with no real asset class (absent, minimal, or `OTHER`): only the instruments metadata can tell its type. */
const needsType = (profile: InstrumentProfile | undefined): boolean => profile === undefined || profile.assetClass === 'OTHER';

const stable = (profile: InstrumentProfile): string => JSON.stringify([...Object.entries(profile)].sort(([a], [b]) => a.localeCompare(b)));

/** The baseline merged over what is stored, or undefined when it would change nothing. */
function changed(existing: InstrumentProfile | undefined, held: HeldInstrument, meta: TradableInstrument | undefined): InstrumentProfile | undefined {
  const { symbol, instrument } = held;
  const baseline = trading212Profile(
    symbol,
    {
      ticker: instrument.ticker,
      name: instrument.name ?? meta?.name,
      shortName: meta?.shortName,
      type: meta?.type,
      isin: instrument.isin ?? meta?.isin,
      currency: instrument.currency || meta?.currencyCode,
    },
    existing?.currency ?? 'EUR',
  );
  const merged = mergeProfile(existing, baseline);
  return existing !== undefined && stable(existing) === stable(merged) ? undefined : merged;
}

/**
 * Writes the baseline profile of every held symbol it improves, as ONE batched write, and resolves how many it wrote. Never throws:
 * a failure of the metadata or of the store is logged and leaves the profiles as they were (the next run tries again).
 */
export async function refreshBaselines(profiles: ProfileStore, held: readonly HeldInstrument[], loadInstruments: () => Promise<TradableInstrument[]>): Promise<number> {
  if (held.length === 0) return 0;
  try {
    const existing = await profiles.get(held.map((entry) => entry.symbol));
    const list = held.some((entry) => needsType(existing.get(entry.symbol))) ? await loadInstruments().catch(() => []) : [];
    const byTicker = new Map(list.map((instrument) => [instrument.ticker, instrument]));
    const writes = held.flatMap((entry) => changed(existing.get(entry.symbol), entry, byTicker.get(entry.instrument.ticker)) ?? []);
    await profiles.putMany(writes);
    return writes.length;
  } catch {
    logger.warn('Could not refresh the Trading 212 baseline profiles');
    return 0;
  }
}
