import type { ClassificationInstrument } from '@portfolio/shared';
import { fieldsToSend, initialForm, NOTHING_TO_SAVE, validateFields } from './classificationForm';
import { valueLabel } from './labels';

const instrument = (patch: Partial<ClassificationInstrument> = {}): ClassificationInstrument => ({
  symbol: 'ACME',
  effective: { name: 'Acme Corp', assetClass: 'STOCK', sector: 'Industrials', country: 'Germany' },
  base: { name: 'Acme Corp', assetClass: 'STOCK', sector: 'Industrials', country: 'Germany' },
  source: 'provider',
  isin: null,
  currency: 'EUR',
  override: null,
  held: true,
  updatedAt: null,
  ...patch,
});

describe('initialForm', () => {
  it('starts at the effective values, a missing sector or country as an empty field', () => {
    expect(initialForm(instrument())).toEqual({ name: 'Acme Corp', assetClass: 'STOCK', sector: 'Industrials', country: 'Germany', domain: '' });
    expect(initialForm({ effective: { name: 'X', assetClass: 'ETF', sector: null, country: null } })).toEqual({ name: 'X', assetClass: 'ETF', sector: '', country: '', domain: '' });
    expect(initialForm(instrument({ override: { domain: 'acme.example.com' } })).domain).toBe('acme.example.com');
  });
});

describe('fieldsToSend', () => {
  const { base } = instrument();

  it('sends nothing for an unchanged form', () => {
    expect(fieldsToSend(initialForm(instrument()), base)).toEqual({});
  });

  it('sends only the fields that differ from the automatic value, trimmed', () => {
    expect(fieldsToSend({ name: ' Acme Group ', assetClass: 'ETF', sector: 'Industrials', country: ' France', domain: '' }, base)).toEqual({ name: 'Acme Group', assetClass: 'ETF', country: 'France' });
  });

  it('does not override a field that was emptied or typed back to the automatic value', () => {
    expect(fieldsToSend({ name: '  ', assetClass: 'STOCK', sector: '', country: 'Germany', domain: '   ' }, base)).toEqual({});
  });

  it('sends the website domain as typed, trimmed, and nothing when it is empty', () => {
    expect(fieldsToSend({ ...initialForm(instrument()), domain: ' https://www.acme.example.com ' }, base)).toEqual({ domain: 'https://www.acme.example.com' });
    expect(fieldsToSend({ ...initialForm(instrument()), domain: '' }, base)).toEqual({});
  });

  it('overrides a field the profile has no value for', () => {
    expect(fieldsToSend({ name: 'Acme Corp', assetClass: 'STOCK', sector: 'Mining', country: '', domain: '' }, { ...base, sector: null, country: null })).toEqual({ sector: 'Mining' });
  });
});

describe('validateFields', () => {
  it('asks for at least one value', () => {
    expect(validateFields({})).toBe(NOTHING_TO_SAVE);
  });

  it('accepts valid fields', () => {
    expect(validateFields({ sector: 'Mining', assetClass: 'COMMODITY' })).toBeNull();
  });

  it('names the field that is too long', () => {
    expect(validateFields({ sector: 'x'.repeat(61) })).toMatch(/^Sector: /);
    expect(validateFields({ name: 'x'.repeat(121) })).toMatch(/^Name: /);
  });

  it('accepts a website domain on its own and names it when it is not one', () => {
    expect(validateFields({ domain: 'https://www.acme.example.com/about' })).toBeNull();
    expect(validateFields({ domain: 'acme' })).toBe('Website domain: Enter a website domain such as apple.com');
  });

  it('falls back to a general label for a problem outside the four fields', () => {
    expect(validateFields({ assetClass: 'NOPE' as never })).toMatch(/^Asset class: /);
    expect(validateFields({ bogus: 'x', sector: 'ok' } as never)).toMatch(/^Classification: /);
  });
});

describe('valueLabel', () => {
  it('shows asset classes by label, unknown classes as written and a missing value as not set', () => {
    expect(valueLabel('assetClass', 'REAL_ESTATE')).toBe('Real estate');
    expect(valueLabel('assetClass', 'COMMODITY')).toBe('Commodity');
    expect(valueLabel('assetClass', 'MYSTERY')).toBe('MYSTERY');
    expect(valueLabel('sector', 'Mining')).toBe('Mining');
    expect(valueLabel('sector', null)).toBe('not set');
    expect(valueLabel('country', undefined)).toBe('not set');
    expect(valueLabel('country', '')).toBe('not set');
  });
});
