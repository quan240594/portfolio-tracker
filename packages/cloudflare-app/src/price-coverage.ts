import { ItemRepository } from '@portfolio/api';
import type { ItemStore } from '@portfolio/platform';
import { PriceRepository, providerOf, type LastAttempt, type PricesConfig } from '@portfolio/prices';
import {
  MAX_COVERAGE_ROWS,
  MAX_COVERAGE_SYMBOLS,
  buildPositions,
  coverageTotals,
  isMarketSymbol,
  sanitizeAttemptError,
  sortCoverage,
  summarizeEod,
  symbolCoverage,
  type CoverageAttempt,
  type PriceHistoryCoverage,
  type Quote,
  type Transaction,
} from '@portfolio/shared';

export interface CoverageDeps {
  items: ItemStore;
  config: PricesConfig;
  now: () => Date;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** The open positions that a market-data provider can price, by symbol, with the date of the first transaction of each. */
function heldSymbols(transactions: readonly Transaction[]): Map<string, string> {
  const open = [...buildPositions(transactions).values()].filter((position) => position.quantity > 0 && isMarketSymbol(position.symbol));
  const first = new Map<string, string>();
  for (const { symbol, date } of transactions) {
    const known = first.get(symbol);
    if (known === undefined || date < known) first.set(symbol, date);
  }
  return new Map(open.map(({ symbol }) => [symbol, first.get(symbol)!]));
}

const attemptOf = (attempt: LastAttempt | undefined): CoverageAttempt | null =>
  attempt === undefined ? null : { day: attempt.day, attempts: attempt.attempts, outcome: attempt.outcome, error: sanitizeAttemptError(attempt.error) };

const quoteOf = (quote: Quote | undefined): { asOf: string; source: string } | null => (quote === undefined ? null : { asOf: quote.asOf, source: quote.source });

/**
 * The price-history coverage of the user's open positions (`GET /prices/status` -> `history`). Reads: the transactions of the user, then
 * ONE query per held symbol (the newest `MAX_COVERAGE_ROWS` + 1 EOD rows), and one batched read each for the quotes, the names and the
 * last recorded history attempts, plus the provider blocks. At most `MAX_COVERAGE_SYMBOLS` symbols (the others only count in `held`).
 */
export async function loadPriceCoverage({ items, config, now }: Readonly<CoverageDeps>, userId: string): Promise<PriceHistoryCoverage> {
  const today = isoDay(now());
  const transactions = await new ItemRepository(items).listTransactions(userId);
  const held = heldSymbols(transactions);
  const symbols = [...held.keys()].sort((a, b) => a.localeCompare(b)).slice(0, MAX_COVERAGE_SYMBOLS);
  const prices = new PriceRepository(items);
  const providers = [...new Set(symbols.map((symbol) => providerOf(symbol)))];
  const [eod, quotes, profiles, attempts, blocked] = await Promise.all([
    Promise.all(symbols.map((symbol) => prices.newestEod(symbol, MAX_COVERAGE_ROWS + 1))),
    prices.latestQuotes(symbols),
    new ItemRepository(items).getProfiles(symbols),
    prices.lastAttempts(symbols),
    prices.blockedProviders(providers, now()),
  ]);
  const rows = symbols.map((symbol, index) => {
    const read = eod[index]!;
    const provider = providerOf(symbol);
    const capped = read.length > MAX_COVERAGE_ROWS;
    return symbolCoverage(
      {
        symbol,
        name: profiles[symbol]?.name ?? symbol,
        provider,
        keyConfigured: config.keys[provider as keyof PricesConfig['keys']] !== undefined,
        providerBlocked: blocked.has(provider),
        firstTransaction: held.get(symbol)!,
        eod: summarizeEod(capped ? read.slice(0, MAX_COVERAGE_ROWS) : read, capped),
        quote: quoteOf(quotes.get(symbol)),
        attempt: attemptOf(attempts.get(symbol)),
      },
      today,
    );
  });
  const rowsRead = transactions.length + eod.reduce((sum, read) => sum + read.length, 0) + quotes.size + Object.keys(profiles).length + attempts.size;
  return { asOf: now().toISOString(), symbols: sortCoverage(rows), totals: coverageTotals(rows, held.size, today), rowsRead };
}
