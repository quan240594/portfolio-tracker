/** In-memory classification overrides of the demo user, valid for one demo seed (a reset of the demo data forgets them). */
import { applyClassificationOverrides, classificationFieldsOf, type ClassificationFields, type InstrumentProfile } from '@portfolio/shared';
import type { MockSeed } from './fixtures';

export interface StoredOverride {
  fields: ClassificationFields;
  updatedAt: string;
}

interface Store {
  seed: MockSeed | null;
  overrides: Map<string, StoredOverride>;
}

let store: Store = { seed: null, overrides: new Map() };

export function overridesOf(seed: MockSeed): Map<string, StoredOverride> {
  if (store.seed !== seed) store = { seed, overrides: new Map() };
  return store.overrides;
}

export function setOverride(seed: MockSeed, symbol: string, fields: ClassificationFields, updatedAt: string): void {
  overridesOf(seed).set(symbol, { fields: classificationFieldsOf(fields), updatedAt });
}

/** The seed's profiles with the overrides on top: what holdings, allocation and analytics group by. */
export function effectiveProfiles(seed: MockSeed): Record<string, InstrumentProfile> {
  const overrides = overridesOf(seed);
  if (overrides.size === 0) return seed.profiles;
  return applyClassificationOverrides(seed.profiles, Object.fromEntries([...overrides].map(([symbol, stored]) => [symbol, stored.fields])));
}
