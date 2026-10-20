import { parsePricesConfig } from '@portfolio/prices';
import type { T212QuoteStatus } from '@portfolio/shared';
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

  it('reports the Trading 212 quotes as a source with their freshness, and says what still needs a key', () => {
    const t212: T212QuoteStatus = { userId: 'u1', state: 'OK', lastAttemptAt: '2026-10-20T10:15:00.000Z', lastSuccessAt: '2026-10-20T10:15:00.000Z', failures: 0, quoted: 25 };
    const result = pricesStatus(parsePricesConfig({}), t212);
    expect(result.state).toBe('no-keys');
    expect(result.t212Quotes).toEqual({ state: 'OK', lastAttemptAt: t212.lastAttemptAt, lastSuccessAt: t212.lastSuccessAt, quoted: 25, lastError: null, nextAttemptAt: null });
    expect(result.sources.find((source) => source.name === 't212')).toMatchObject({ configured: true, secret: null });
    expect(result.missingSecrets).toHaveLength(4);
    expect(result.message).toBe('No market-data API key is set: exchange rates are refreshed and held positions are priced from Trading 212 (last refresh 2026-10-20T10:15:00.000Z); charts and history need the secrets listed in missingSecrets.');
    const partial = pricesStatus(parsePricesConfig({ TWELVEDATA_API_KEY: 'a' }), t212);
    expect(partial.message).toContain('held positions are priced from Trading 212');
    expect(partial.state).toBe('partial');
  });

  it('reports a failing Trading 212 refresh without claiming live prices', () => {
    const failing: T212QuoteStatus = { userId: 'u1', state: 'RATE_LIMITED', lastAttemptAt: '2026-10-20T10:15:00.000Z', failures: 2, nextAttemptAt: '2026-10-20T10:25:00.000Z', lastError: 'T212_RATE_LIMITED: HTTP 429' };
    const result = pricesStatus(parsePricesConfig({}), failing);
    expect(result.t212Quotes).toMatchObject({ state: 'RATE_LIMITED', lastSuccessAt: null, quoted: null, nextAttemptAt: '2026-10-20T10:25:00.000Z', lastError: 'T212_RATE_LIMITED: HTTP 429' });
    expect(result.sources.find((source) => source.name === 't212')?.configured).toBe(false);
    expect(result.message).toContain('only exchange rates are refreshed');
    expect(result.message).not.toContain('Trading 212');
  });

  it('keeps the plain message when every key is set, whatever Trading 212 does', () => {
    const all = { TWELVEDATA_API_KEY: 'a', EODHD_API_KEY: 'b', COINGECKO_API_KEY: 'c', ALPHAVANTAGE_API_KEY: 'd' };
    expect(pricesStatus(parsePricesConfig(all), null).message).toBe('Every market-data source is configured.');
    expect(pricesStatus(parsePricesConfig(all), { userId: 'u1', state: 'ERROR', lastAttemptAt: '2026-10-20T10:15:00.000Z', failures: 1 })).toMatchObject({ state: 'ok', missingSecrets: [] });
  });
});
