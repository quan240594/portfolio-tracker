import { parsePricesConfig } from '@portfolio/prices';
import { describe, expect, it } from 'vitest';
import { pricesStatus } from './prices-status.js';

const status = (env: Record<string, string>) => pricesStatus(parsePricesConfig(env));

describe('pricesStatus', () => {
  it('reports no keys as a normal state, listing the secrets to set and never a value', () => {
    const result = status({});
    expect(result).toMatchObject({ state: 'no-keys', missingSecrets: ['TWELVEDATA_API_KEY', 'EODHD_API_KEY', 'COINGECKO_API_KEY', 'ALPHAVANTAGE_API_KEY'] });
    expect(result.sources.find((source) => source.name === 'frankfurter')).toMatchObject({ configured: true, secret: null });
    expect(result.message).toContain('only exchange rates are refreshed');
  });

  it('reports a partial setup and which source each key switches on', () => {
    const result = status({ TWELVEDATA_API_KEY: 'td-value', COINGECKO_API_KEY: '  ' });
    expect(result.state).toBe('partial');
    expect(result.missingSecrets).toEqual(['EODHD_API_KEY', 'COINGECKO_API_KEY', 'ALPHAVANTAGE_API_KEY']);
    expect(result.sources.find((source) => source.name === 'twelvedata')).toMatchObject({ configured: true, secret: 'TWELVEDATA_API_KEY' });
    expect(JSON.stringify(result)).not.toContain('td-value');
  });

  it('is ok when every source is configured', () => {
    expect(status({ TWELVEDATA_API_KEY: 'a', EODHD_API_KEY: 'b', COINGECKO_API_KEY: 'c', ALPHAVANTAGE_API_KEY: 'd' })).toMatchObject({ state: 'ok', missingSecrets: [] });
  });
});
