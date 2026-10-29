import { describe, expect, it } from 'vitest';
import { ALPHAVANTAGE_PROBE_ROUTES, PROBE_OUTCOMES, alphaVantageProbeResultSchema, alphaVantageProbeStatusSchema, probeSummary } from './alphavantage-probe.js';

const budget = { provider: 'Alpha Vantage', day: '2026-10-29', used: 2, limit: 25, remaining: 23, calendarUsed: 1, calendarLimit: 1 };
const result = { at: '2026-10-29T08:20:00.000Z', symbol: 'IBM', call: 'EARNINGS_ESTIMATES', outcome: 'ok', summary: 'ok: 12 quarters', quarters: 12 };

describe('Alpha Vantage probe contract', () => {
  it('names its routes', () => {
    expect(ALPHAVANTAGE_PROBE_ROUTES).toEqual({ alphaVantageProbeStatus: 'GET /diagnostics/alphavantage-probe', alphaVantageProbe: 'POST /diagnostics/alphavantage-probe' });
  });

  it('has words for every outcome', () => {
    expect(probeSummary('ok', 12)).toBe('ok: 12 quarters');
    expect(probeSummary('ok', 1)).toBe('ok: 1 quarter');
    expect(probeSummary('ok')).toBe('ok: 0 quarters');
    expect(probeSummary('premium')).toBe('premium endpoint: the free key cannot use it');
    expect(probeSummary('daily-limit')).toMatch(/^rate limit \(daily\)/);
    expect(probeSummary('burst-limit')).toMatch(/^rate limit \(burst\)/);
    expect(probeSummary('rate-limited')).toMatch(/^rate limit \(unspecified\)/);
    expect(probeSummary('invalid-key')).toMatch(/^invalid key/);
    expect(probeSummary('no-coverage')).toMatch(/^no data/);
    expect(probeSummary('error')).toMatch(/^error/);
    expect(new Set(PROBE_OUTCOMES.map((outcome) => probeSummary(outcome))).size).toBe(PROBE_OUTCOMES.length);
  });

  it('parses a status and a result, and refuses anything else', () => {
    expect(alphaVantageProbeStatusSchema.safeParse({ available: true, reason: null, nextAllowedAt: null, budget, last: result }).success).toBe(true);
    expect(alphaVantageProbeStatusSchema.safeParse({ available: false, reason: 'No key', nextAllowedAt: null, budget: null, last: null, sample: true }).success).toBe(true);
    expect(alphaVantageProbeStatusSchema.safeParse({ available: true }).success).toBe(false);
    expect(alphaVantageProbeStatusSchema.safeParse({ available: true, reason: null, nextAllowedAt: null, budget: null, last: { ...result, outcome: 'weird' } }).success).toBe(false);
    expect(alphaVantageProbeResultSchema.safeParse({ ...result, budget }).success).toBe(true);
    expect(alphaVantageProbeResultSchema.safeParse(result).success).toBe(false);
  });
});
