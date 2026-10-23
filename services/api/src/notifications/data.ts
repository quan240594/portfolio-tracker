import { logger } from '@portfolio/platform';
import {
  baselineEntries,
  heldQuantities,
  isMarketSymbol,
  localDayAndHour,
  type DividendEvent,
  type EarningsSummary,
  type FxRates,
  type NotificationType,
  type Transaction,
} from '@portfolio/shared';
import type { Repository } from '../repository.js';
import type { NotificationRepository } from './repository.js';

export interface DividendData {
  transactions: Transaction[];
  /** Stored dividend events of the held symbols. */
  dividendEvents: DividendEvent[];
  names: Record<string, string | undefined>;
  fx: FxRates | null;
  /** The newest stored earnings summaries of the held symbols. */
  earnings: EarningsSummary[];
}

export interface HeldDividends {
  transactions: Transaction[];
  held: string[];
  dividendEvents: DividendEvent[];
  earnings: EarningsSummary[];
}

/** Summaries read per held symbol: the newest two are enough to see what is new (older ones were announced or recorded silently). */
const EARNINGS_PER_SYMBOL = 2;

/** The transactions of the user and the stored dividend events of the symbols held on `today`. Throws when the transactions cannot be replayed. */
export async function loadHeldDividends(repo: Repository, userId: string, today: string): Promise<HeldDividends> {
  const transactions = await repo.listTransactions(userId);
  const held = [...heldQuantities(transactions, today).keys()].filter(isMarketSymbol);
  const [events, summaries] = await Promise.all([
    Promise.all(held.map((symbol) => repo.getDividendEvents(symbol))),
    Promise.all(held.map((symbol) => repo.getEarningsSummaries(symbol, EARNINGS_PER_SYMBOL))),
  ]);
  return { transactions, held, dividendEvents: events.flat(), earnings: summaries.flat() };
}

/** Everything the notification logic needs about one user: `loadHeldDividends` plus the company names (held and dividend-paying symbols) and the FX rates. */
export async function loadDividendData(repo: Repository, userId: string, today: string, baseCurrency: string): Promise<DividendData> {
  const { transactions, held, dividendEvents, earnings } = await loadHeldDividends(repo, userId, today);
  const paid = transactions.filter((t) => t.type === 'DIVIDEND').map((t) => t.symbol);
  const named = [...new Set([...held, ...paid])].filter(isMarketSymbol);
  const [profiles, fx] = await Promise.all([repo.getProfiles(named), repo.getFx(baseCurrency)]);
  return { transactions, dividendEvents, earnings, names: Object.fromEntries(Object.entries(profiles).map(([symbol, profile]) => [symbol, profile.name])), fx };
}

/**
 * Marks the existing dividend transactions and the currently declared upcoming dividends as already notified (silently), so that
 * switching notifications on never announces history. A failure is logged and swallowed: the notification job fails the same way
 * for such a user, so nothing is sent either.
 */
export async function baselineUser(repo: Repository, notifications: NotificationRepository, userId: string, now: Date, types: readonly NotificationType[]): Promise<void> {
  try {
    const { day } = localDayAndHour(now);
    const { transactions, dividendEvents, earnings } = await loadHeldDividends(repo, userId, day);
    const entries = baselineEntries({ today: day, transactions, dividendEvents, earnings, types });
    await notifications.recordNotified(userId, entries, now.toISOString(), true);
  } catch {
    logger.warn('Could not baseline the notification ledger');
  }
}
