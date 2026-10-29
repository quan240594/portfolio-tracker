import { describe, expect, it } from 'vitest';
import { ALPHAVANTAGE_PROBE_ROUTES, CONCLUSION_TEXT, PROBE_CONCLUSIONS, PROBE_MIN_CALLS, PROBE_OUTCOMES, alphaVantageProbeResultSchema, alphaVantageProbeStatusSchema, probeComparison, probeConclusion, probeShort, probeSummary } from './alphavantage-probe.js';

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

  it('needs four calls left: the test and its control', () => {
    expect(PROBE_MIN_CALLS).toBe(4);
  });

  it('parses a result with its control call, the comparison and the conclusion', () => {
    const full = {
      ...result,
      outcome: 'rate-limited',
      summary: probeSummary('rate-limited'),
      control: { call: 'EARNINGS', outcome: 'ok', summary: 'ok: 80 quarters', quarters: 80 },
      comparison: 'EARNINGS_ESTIMATES: refused (generic limit text) / EARNINGS: ok, 80 quarters',
      conclusion: { kind: 'estimates-unavailable', text: CONCLUSION_TEXT['estimates-unavailable'] },
      budget,
    };
    expect(alphaVantageProbeResultSchema.safeParse(full).success).toBe(true);
    expect(alphaVantageProbeStatusSchema.safeParse({ available: true, reason: null, nextAllowedAt: null, budget, last: full }).success).toBe(true);
    expect(alphaVantageProbeResultSchema.safeParse({ ...full, control: { ...full.control, call: 'EARNINGS_ESTIMATES' } }).success).toBe(false);
    expect(alphaVantageProbeResultSchema.safeParse({ ...full, conclusion: { kind: 'weird', text: 'x' } }).success).toBe(false);
  });

  it('puts the two outcomes side by side', () => {
    expect(probeComparison({ outcome: 'rate-limited' }, { outcome: 'ok', quarters: 80 })).toBe('EARNINGS_ESTIMATES: refused (generic limit text) / EARNINGS: ok, 80 quarters');
    expect(probeComparison({ outcome: 'ok', quarters: 1 }, { outcome: 'ok', quarters: 1 })).toBe('EARNINGS_ESTIMATES: ok, 1 quarter / EARNINGS: ok, 1 quarter');
    expect(probeComparison({ outcome: 'daily-limit' })).toBe('EARNINGS_ESTIMATES: refused (daily limit)');
    expect(new Set(PROBE_OUTCOMES.map((outcome) => probeShort(outcome))).size).toBe(PROBE_OUTCOMES.length);
    expect(probeShort('ok')).toBe('ok, 0 quarters');
    expect(probeShort('premium')).toBe('refused (premium endpoint)');
    expect(probeShort('burst-limit')).toBe('refused (burst limit)');
    expect(probeShort('invalid-key')).toBe('refused (invalid key)');
    expect(probeShort('no-coverage')).toMatch(/^no data/);
    expect(probeShort('error')).toBe('no usable answer');
  });

  it('concludes: estimates need a paid plan, a throttle, both fine, or nothing certain', () => {
    expect(probeConclusion('rate-limited', 'ok')?.kind).toBe('estimates-unavailable');
    expect(probeConclusion('premium', 'ok')?.kind).toBe('estimates-unavailable');
    expect(probeConclusion('rate-limited', 'rate-limited')?.kind).toBe('throttled');
    expect(probeConclusion('burst-limit', 'daily-limit')?.kind).toBe('throttled');
    expect(probeConclusion('daily-limit')?.kind).toBe('throttled');
    expect(probeConclusion('ok', 'ok')?.kind).toBe('both-ok');
    expect(probeConclusion('ok', 'rate-limited')?.kind).toBe('inconclusive');
    expect(probeConclusion('burst-limit', 'ok')?.kind).toBe('inconclusive');
    expect(probeConclusion('error', 'error')?.kind).toBe('inconclusive');
    expect(probeConclusion('invalid-key')).toBeUndefined();
    expect(probeConclusion('rate-limited')).toBeUndefined();
    expect(probeConclusion('rate-limited', 'ok')?.text).toBe(CONCLUSION_TEXT['estimates-unavailable']);
    expect(CONCLUSION_TEXT['estimates-unavailable']).toContain('Your key can read EARNINGS but not EARNINGS_ESTIMATES: estimates (and revenue consensus) need a paid Alpha Vantage plan');
    expect(CONCLUSION_TEXT.throttled).toBe('Both calls were limited: you are being throttled, try later.');
    expect(Object.keys(CONCLUSION_TEXT)).toEqual([...PROBE_CONCLUSIONS]);
  });
});
