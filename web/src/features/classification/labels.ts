import type { ClassificationField, ClassificationUnmatchedReason, ProfileSource } from '@portfolio/shared';
import { ASSET_CLASS_LABELS } from '../assets/AssetDialog';

export const FIELD_LABELS: Readonly<Record<ClassificationField, string>> = {
  name: 'Name',
  assetClass: 'Asset class',
  sector: 'Sector',
  country: 'Country',
};

export const REASON_LABELS: Readonly<Record<ClassificationUnmatchedReason, string>> = {
  'not-held': 'Not one of your holdings',
  ambiguous: 'Fits more than one of your holdings, so nothing was guessed',
  'isin-mismatch': 'Its ISIN differs from the ISIN of the holding with this ticker',
  duplicate: 'An earlier row already sets this holding',
  empty: 'Nothing to import: no name, class, sector or country',
};

export const SOURCE_LABELS: Readonly<Record<ProfileSource | 'none', string>> = {
  provider: 'a market-data provider',
  trading212: 'Trading 212',
  minimal: 'the ticker alone (no profile data yet)',
  none: 'no stored profile yet',
};

/** What the automatic value is called next to a field in the edit dialog. */
export const BASE_LABELS: Readonly<Record<ProfileSource | 'none', string>> = {
  provider: 'Provider value',
  trading212: 'Trading 212 value',
  minimal: 'Value derived from the ticker',
  none: 'Automatic value',
};

export const NOT_SET = 'not set';

/** A value as the screens show it: asset classes by their label, a missing value as "not set". */
export function valueLabel(field: ClassificationField, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return NOT_SET;
  if (field !== 'assetClass') return value;
  return (ASSET_CLASS_LABELS as Readonly<Record<string, string>>)[value] ?? value;
}
