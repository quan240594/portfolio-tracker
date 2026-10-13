import { describe, expect, it } from 'vitest';
import {
  ALL_PORTFOLIOS,
  DEFAULT_PORTFOLIO_ID,
  ENTITY,
  allocationQuerySchema,
  createImportSchema,
  createPortfolioSchema,
  csvRowSchema,
  historyQuerySchema,
  keys,
  portfolioIdSchema,
  portfolioScopeSchema,
  transactionInputSchema,
  updatePortfolioSchema,
} from './index.js';

describe('multi-portfolio contract', () => {
  it('keys scope transactions per portfolio under the user partition', () => {
    expect(keys.portfolio('u', 'default')).toEqual({ PK: 'USER#u', SK: 'PORTFOLIO#default' });
    expect(keys.portfolioPrefix).toBe('PORTFOLIO#');
    expect(keys.portfolioTransactionPrefix('p1')).toBe('TXN#p1#');
    expect(keys.transaction('u', 'p1', '2026-01-02', 'x').SK.startsWith(keys.portfolioTransactionPrefix('p1'))).toBe(true);
    expect(keys.transaction('u', 'p1', '2026-01-02', 'x').SK.startsWith(keys.transactionPrefix)).toBe(true);
    expect(ENTITY.portfolio).toBe('PORTFOLIO');
  });

  it('validates portfolio ids and names', () => {
    expect(portfolioIdSchema.safeParse(DEFAULT_PORTFOLIO_ID).success).toBe(true);
    expect(portfolioIdSchema.safeParse('3f2b8c1e-1d2a-4f00-9a7b-0c1d2e3f4a5b').success).toBe(true);
    for (const bad of ['', 'A', 'has#hash', '-lead', 'x'.repeat(65)]) expect(portfolioIdSchema.safeParse(bad).success).toBe(false);
    expect(createPortfolioSchema.parse({ name: '  Trading 212  ' })).toEqual({ name: 'Trading 212' });
    expect(updatePortfolioSchema.safeParse({ name: ' ' }).success).toBe(false);
    expect(createPortfolioSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
  });

  it('requires a portfolio on writes but not on CSV rows', () => {
    const row = { date: '2026-01-02', type: 'BUY', symbol: 'AAPL', quantity: 1, price: 1, currency: 'USD' };
    expect(transactionInputSchema.safeParse(row).success).toBe(false);
    expect(transactionInputSchema.parse({ ...row, portfolioId: 'default' }).portfolioId).toBe('default');
    expect(csvRowSchema.parse(row)).not.toHaveProperty('portfolioId');
    expect(createImportSchema.safeParse({ fileName: 'a.csv' }).success).toBe(false);
    expect(createImportSchema.parse({ fileName: 'a.csv', portfolioId: 'default' }).portfolioId).toBe('default');
  });

  it('read scopes accept an optional portfolio, including the combined id', () => {
    expect(portfolioScopeSchema.parse({})).toEqual({});
    expect(portfolioScopeSchema.parse({ portfolioId: ALL_PORTFOLIOS }).portfolioId).toBe('all');
    expect(allocationQuerySchema.parse({ portfolioId: 'p1' })).toEqual({ by: 'assetClass', portfolioId: 'p1' });
    expect(historyQuerySchema.parse({})).toEqual({ range: '1Y' });
  });
});
