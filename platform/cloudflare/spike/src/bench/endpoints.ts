import type { Case } from './harness.ts';

const R = 'GET';
/** Every API route that computes something, with the heaviest realistic query for each (the web app's default pages). */
export const COMPUTE_CASES: Case[] = [
  { id: 'portfolio', method: R, path: '/portfolio' },
  { id: 'holdings', method: R, path: '/holdings' },
  { id: 'allocation (assetClass)', method: R, path: '/allocation', query: { by: 'assetClass' } },
  { id: 'allocation (category)', method: R, path: '/allocation', query: { by: 'category', portfolioId: 'default' } },
  { id: 'history (1Y)', method: R, path: '/history', query: { range: '1Y' } },
  { id: 'history (ALL)', method: R, path: '/history', query: { range: 'ALL' } },
  { id: 'dividends', method: R, path: '/dividends' },
  { id: 'analytics/summary', method: R, path: '/analytics/summary' },
  { id: 'analytics/returns (year)', method: R, path: '/analytics/returns', query: { period: 'year' } },
  { id: 'analytics/returns (month)', method: R, path: '/analytics/returns', query: { period: 'month' } },
  { id: 'analytics/risk', method: R, path: '/analytics/risk', query: { benchmark: 'IWDA.AS' } },
  { id: 'analytics/benchmark (ALL)', method: R, path: '/analytics/benchmark', query: { benchmark: 'IWDA.AS', range: 'ALL' } },
  { id: 'analytics/dividend-growth', method: R, path: '/analytics/dividend-growth' },
  { id: 'analytics/goal', method: R, path: '/analytics/goal' },
  { id: 'analytics/growth (1Y)', method: R, path: '/analytics/growth', query: { range: '1Y', benchmarks: 'IWDA.AS' } },
  { id: 'analytics/growth (ALL, 3 bench)', method: R, path: '/analytics/growth', query: { range: 'ALL', benchmarks: 'IWDA.AS,VWRL.AS,EMIM.AS' } },
  { id: 'analytics/holdings-performance (ALL)', method: R, path: '/analytics/holdings-performance', query: { range: 'ALL' } },
  { id: 'analytics/metrics', method: R, path: '/analytics/metrics', query: { benchmark: 'IWDA.AS' } },
  { id: 'dividends/overview', method: R, path: '/dividends/overview' },
  { id: 'calendar', method: R, path: '/calendar' },
  { id: 'calendar.ics', method: R, path: '/calendar.ics' },
  { id: 'goals (GET)', method: R, path: '/goals' },
  { id: 'goals/calculate (POST)', method: 'POST', path: '/goals/calculate', body: { goalType: 'income', targetAmount: 24000, targetYear: 2040, monthlyContribution: 1000, priceReturnPct: 6, startYieldPct: null, dividendGrowthPct: 5, yieldOnNewMoneyPct: 3.5, inflationPct: 2, adjustForInflation: true, reinvestDividends: true } },
  { id: 'assets/AAPL', method: R, path: '/assets/AAPL' },
  { id: 'assets/AAPL/history (ALL)', method: R, path: '/assets/AAPL/history', query: { range: 'ALL', benchmarks: 'IWDA.AS' } },
  { id: 'assets/AAPL/positions', method: R, path: '/assets/AAPL/positions' },
  { id: 'securities/closed', method: R, path: '/securities/closed' },
  { id: 'rebalance (buy-only)', method: R, path: '/portfolios/default/rebalance', query: { mode: 'buy-only', amount: '5000' } },
  { id: 'rebalance (full)', method: R, path: '/portfolios/default/rebalance', query: { mode: 'full', amount: '2000', wholeUnits: 'true' } },
  { id: 'export/transactions (csv)', method: R, path: '/export/transactions' },
  { id: 'export/backup (json)', method: R, path: '/export/backup' },
];

/** Cheap routes, listed for completeness (they are dominated by decode + JSON.stringify). */
export const LIGHT_CASES: Case[] = [
  { id: 'health', method: R, path: '/health' },
  { id: 'portfolios (list)', method: R, path: '/portfolios' },
  { id: 'transactions (list, all)', method: R, path: '/transactions' },
  { id: 'transactions (list, one pf)', method: R, path: '/transactions', query: { portfolioId: 'default' } },
  { id: 'categories (list)', method: R, path: '/portfolios/default/categories' },
  { id: 'assets (list)', method: R, path: '/portfolios/default/assets' },
  { id: 'watchlist', method: R, path: '/watchlist' },
  { id: 'settings (GET)', method: R, path: '/portfolios/default/settings' },
];

export const WRITE_CASES: Case[] = [
  {
    id: 'POST /transactions (1 buy)', method: 'POST', path: '/transactions', write: true,
    body: { portfolioId: 'default', date: '2026-10-14', type: 'BUY', symbol: 'AAPL', quantity: 1, price: 200, fee: 1, currency: 'USD' },
  },
  { id: 'PUT /goals', method: 'PUT', path: '/goals', write: true, body: { goalType: 'income', targetAmount: 24000, targetYear: 2040, monthlyContribution: 1000, priceReturnPct: 6, startYieldPct: null, dividendGrowthPct: 5, yieldOnNewMoneyPct: 3.5, inflationPct: 2, adjustForInflation: true, reinvestDividends: true } },
  { id: 'POST /watchlist', method: 'POST', path: '/watchlist', write: true, body: { symbol: 'TSM' } },
];

export const ALL_READ_CASES: Case[] = [...COMPUTE_CASES, ...LIGHT_CASES];
