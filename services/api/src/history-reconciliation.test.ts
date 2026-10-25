import { describe, expect, it } from 'vitest';
import { apiEvent } from './testing/fakes.js';
import { LINES, TODAY, ownerScenario as setup, price, rateOf, transactions } from './testing/owner-scenario.js';

const json = (res: { body?: string }) => JSON.parse(res.body ?? 'null');

describe('chart reconciliation: value against invested with prices that only rise', () => {
  it('the value is never below what was invested, and the last day does not jump', async () => {
    const { handler } = setup();
    const history = json(await handler(apiEvent('GET', '/history', { query: { range: '1Y' } })));
    const points: { date: string; value: number; invested: number }[] = history.points;
    expect(points.length).toBeGreaterThan(300);
    const below = points.filter((p) => p.value < p.invested - 0.01);
    expect(below).toEqual([]);
    const last = points.at(-1)!;
    const before = points.at(-2)!;
    expect(Math.abs(last.value - before.value) / before.value).toBeLessThan(0.02);
  });

  it('every day is within a percent of the true value of the lines that have prices, plus the cost of the line without any', async () => {
    const { handler } = setup();
    const history = json(await handler(apiEvent('GET', '/history', { query: { range: '3M' } })));
    const bought = transactions();
    for (const point of history.points.filter((p: { date: string }) => p.date < TODAY)) {
      const truth = LINES.reduce((sum, line) => {
        const units = bought.filter((t) => t.symbol === line.symbol && t.date <= point.date).reduce((n, t) => n + t.quantity, 0);
        const cost = bought.filter((t) => t.symbol === line.symbol && t.date <= point.date).reduce((n, t) => n + t.quantity * t.price, 0);
        const value = line.stored === 'none' ? cost : units * price(line, point.date);
        return sum + value / rateOf(line.currency);
      }, 0);
      expect(Math.abs(point.value - truth) / truth).toBeLessThan(0.01);
    }
  });
});
