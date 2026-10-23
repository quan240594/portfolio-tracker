import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_MODEL } from './ai.js';
import { DEFAULT_DAILY_NEURONS, MAX_DAILY_NEURONS, parseEarningsConfig, validSecContact } from './config.js';

describe('SEC_CONTACT', () => {
  it.each(['PortfolioTracker/1.0 (personal use; owner@example.invalid)', 'my-app https://example.invalid/contact'])('accepts %s', (value) => {
    expect(validSecContact(value)).toBe(true);
    expect(parseEarningsConfig({ SEC_CONTACT: ` ${value} ` })).toMatchObject({ secUserAgent: value });
  });

  it.each([undefined, '', 'short@x', 'no contact information here', 'bad\r\nX-Injected: 1 owner@example.invalid', 'naïve owner@example.invalid', `${'a'.repeat(200)}@example.invalid`])('rejects %j and reports it', (value) => {
    expect(validSecContact(value)).toBe(false);
    const config = parseEarningsConfig({ SEC_CONTACT: value });
    expect(config.secUserAgent).toBeUndefined();
    expect(config.secProblem).toBe(value === undefined || value === '' ? 'missing' : 'invalid');
  });
});

describe('the other variables', () => {
  it('defaults the model and the daily neurons and caps them at 8,000', () => {
    expect(parseEarningsConfig({})).toMatchObject({ model: DEFAULT_AI_MODEL, dailyNeurons: DEFAULT_DAILY_NEURONS, estimatesConfigured: false });
    expect(parseEarningsConfig({ EARNINGS_AI_DAILY_NEURONS: '3000' }).dailyNeurons).toBe(3000);
    expect(parseEarningsConfig({ EARNINGS_AI_DAILY_NEURONS: '0' }).dailyNeurons).toBe(0);
    expect(parseEarningsConfig({ EARNINGS_AI_DAILY_NEURONS: '99999' }).dailyNeurons).toBe(MAX_DAILY_NEURONS);
    expect(parseEarningsConfig({ EARNINGS_AI_DAILY_NEURONS: 'lots' }).dailyNeurons).toBe(DEFAULT_DAILY_NEURONS);
    expect(parseEarningsConfig({ EARNINGS_AI_DAILY_NEURONS: '-5' }).dailyNeurons).toBe(DEFAULT_DAILY_NEURONS);
  });

  it('accepts a Workers AI model id only', () => {
    expect(parseEarningsConfig({ EARNINGS_AI_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }).model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(parseEarningsConfig({ EARNINGS_AI_MODEL: 'https://evil.example/model' }).model).toBe(DEFAULT_AI_MODEL);
    expect(parseEarningsConfig({ EARNINGS_AI_MODEL: ' ' }).model).toBe(DEFAULT_AI_MODEL);
  });

  it('notes whether the Alpha Vantage key exists, never its value', () => {
    expect(parseEarningsConfig({ ALPHAVANTAGE_API_KEY: 'k' }).estimatesConfigured).toBe(true);
    expect(JSON.stringify(parseEarningsConfig({ ALPHAVANTAGE_API_KEY: 'secret-value' }))).not.toContain('secret-value');
  });
});
