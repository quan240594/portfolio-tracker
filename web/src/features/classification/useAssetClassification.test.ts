import type { AssetProfileInfo } from '@portfolio/shared';
import { instrumentFromProfile, withOverride } from './useAssetClassification';

const profile: AssetProfileInfo = {
  symbol: 'ACME',
  name: 'Acme Corp',
  assetClass: 'STOCK',
  sector: 'Industrials',
  country: null,
  exchange: 'XETRA',
  currency: 'EUR',
  description: null,
  isin: null,
};

describe('withOverride', () => {
  it('leaves the profile alone without an override', () => {
    expect(withOverride(profile, null)).toBe(profile);
  });

  it('replaces only the overridden fields', () => {
    expect(withOverride(profile, { country: 'Germany', assetClass: 'ETF' })).toEqual({ ...profile, country: 'Germany', assetClass: 'ETF' });
    expect(withOverride(profile, { name: 'Acme Group', sector: 'Mining' })).toEqual({ ...profile, name: 'Acme Group', sector: 'Mining' });
  });
});

describe('instrumentFromProfile', () => {
  it('takes the public profile as both the effective and the automatic values', () => {
    const instrument = instrumentFromProfile(profile);
    expect(instrument).toMatchObject({ symbol: 'ACME', source: 'none', isin: null, currency: 'EUR', override: null, held: false, updatedAt: null });
    expect(instrument.effective).toEqual({ name: 'Acme Corp', assetClass: 'STOCK', sector: 'Industrials', country: null });
    expect(instrument.base).toEqual(instrument.effective);
  });
});
