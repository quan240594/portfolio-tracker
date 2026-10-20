import type { AssetProfileInfo, ClassificationFields, ClassificationInstrument } from '@portfolio/shared';
import { useClassification } from '../../api/classificationHooks';

/** The instrument as the classification dialog needs it when the API list does not know the symbol (not held, no override): the public profile is the automatic value. */
export function instrumentFromProfile(profile: AssetProfileInfo): ClassificationInstrument {
  const values = { name: profile.name, assetClass: profile.assetClass, sector: profile.sector, country: profile.country };
  return { symbol: profile.symbol, effective: values, base: values, source: 'none', isin: profile.isin, currency: profile.currency, override: null, held: false, updatedAt: null };
}

/** The public profile with the owner's own values on top (only the fields that are overridden change). */
export function withOverride(profile: AssetProfileInfo, override: ClassificationFields | null): AssetProfileInfo {
  if (override === null) return profile;
  return {
    ...profile,
    name: override.name ?? profile.name,
    assetClass: override.assetClass ?? profile.assetClass,
    sector: override.sector ?? profile.sector,
    country: override.country ?? profile.country,
  };
}

/**
 * What the asset detail shows as classification: the public profile, overlaid with the user's override. `ready` is true once the
 * override list is known, which is when the edit control can be offered; a failed list leaves the plain profile in place.
 */
export function useAssetClassification(profile: AssetProfileInfo) {
  const list = useClassification();
  const instrument = list.data?.instruments.find((i) => i.symbol === profile.symbol);
  const override = instrument?.override ?? null;
  return {
    profile: withOverride(profile, override),
    instrument: instrument ?? instrumentFromProfile(profile),
    edited: override !== null,
    ready: list.isSuccess,
  };
}
