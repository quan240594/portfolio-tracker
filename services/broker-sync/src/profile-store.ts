import type { BatchOp, ItemStore } from '@portfolio/platform';
import { ENTITY, fromItem, keys, type InstrumentProfile } from '@portfolio/shared';

/** What the baseline refresh needs of the stored instrument profiles: read the ones of the held symbols, write the changed ones. */
export interface ProfileStore {
  /** The stored profile of every symbol that has one. */
  get(symbols: readonly string[]): Promise<Map<string, InstrumentProfile>>;
  /** Writes the profiles as ONE batched write (rows written = profiles). */
  putMany(profiles: readonly InstrumentProfile[]): Promise<void>;
}

/** The PROFILE item the price service writes too (`TICKER#{symbol}` / `PROFILE`), so the API reads it like any other profile. */
export const profileItem = (profile: InstrumentProfile) => ({ ...keys.profile(profile.symbol), entityType: ENTITY.profile, ...profile });

/** ProfileStore on an ItemStore: the key scheme of the profile items, whatever the storage. */
export class ItemProfileStore implements ProfileStore {
  constructor(private readonly store: ItemStore) {}

  async get(symbols: readonly string[]): Promise<Map<string, InstrumentProfile>> {
    if (symbols.length === 0) return new Map();
    const items = await this.store.getMany(symbols.map((symbol) => keys.profile(symbol)));
    return new Map(items.map((item) => [String(item.symbol), fromItem<InstrumentProfile>(item)]));
  }

  async putMany(profiles: readonly InstrumentProfile[]): Promise<void> {
    if (profiles.length === 0) return;
    await this.store.batchWrite(profiles.map((profile): BatchOp => ({ type: 'put', item: profileItem(profile) })));
  }
}
