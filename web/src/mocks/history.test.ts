import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORTFOLIO_ID } from '@portfolio/shared';
import { addTransaction, getHistory, getPortfolio, getSeed, resetDb } from './db';

describe('mock GET /history', () => {
  beforeEach(() => resetDb());

  it('ends at the headline total and has no valuedAtCost note while every symbol has prices', () => {
    const history = getHistory('1Y');
    expect(history).not.toHaveProperty('valuedAtCost');
    expect(history.points.at(-1)!.value).toBeCloseTo(getPortfolio().totalValue, 1);
  });

  it('lists a symbol the user added: it has no stored prices, so it is valued at cost', () => {
    addTransaction({ portfolioId: DEFAULT_PORTFOLIO_ID, date: getSeed().today, type: 'BUY', symbol: 'NEWCO.AS', quantity: 4, price: 201.35, fee: 0, currency: 'EUR' });
    const history = getHistory('1Y');
    expect(history.valuedAtCost).toMatchObject({ symbols: ['NEWCO.AS'], held: expect.any(Number) });
    expect(history.valuedAtCost!.held).toBeGreaterThan(1);
    expect(history.points.at(-1)!.value).toBeCloseTo(getPortfolio().totalValue, 1);
  });
});
