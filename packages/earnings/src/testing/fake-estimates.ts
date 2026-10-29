import type { AlphaVantageEstimatesClient, EstimatesAnswer } from '@portfolio/prices';

/** A reply of the fake: an answer, an error to throw, or a function of the ticker. */
export type EstimatesReply = EstimatesAnswer | Error | ((ticker: string) => EstimatesAnswer);

/** The `EARNINGS` side of the fake: answers per ticker (`fallback` for the others). */
export interface EarningsReplies {
  replies?: Readonly<Record<string, EstimatesReply>>;
  fallback?: EstimatesReply;
}

const NO_REPLIES: EarningsReplies = {};

function answerOf(reply: EstimatesReply, ticker: string): Promise<EstimatesAnswer> {
  if (reply instanceof Error) return Promise.reject(reply);
  return Promise.resolve(typeof reply === 'function' ? reply(ticker) : reply);
}

/**
 * The fake of the Alpha Vantage consensus client: answers per ticker (`fallback` for the others) and records every call, `EARNINGS_ESTIMATES` in `calls`,
 * `EARNINGS` in `earningsCalls` and both, in order, in `order` (`EARNINGS_ESTIMATES:IBM`). No network.
 */
export class FakeEstimates implements Pick<AlphaVantageEstimatesClient, 'fetchEstimates' | 'fetchEarnings'> {
  readonly calls: string[] = [];
  readonly earningsCalls: string[] = [];
  readonly order: string[] = [];

  constructor(
    private readonly replies: Readonly<Record<string, EstimatesReply>> = {},
    private readonly fallback: EstimatesReply = { status: 'no-coverage' },
    private readonly earnings: EarningsReplies = NO_REPLIES,
  ) {}

  fetchEstimates(ticker: string): Promise<EstimatesAnswer> {
    this.calls.push(ticker);
    this.order.push(`EARNINGS_ESTIMATES:${ticker}`);
    return answerOf(this.replies[ticker] ?? this.fallback, ticker);
  }

  fetchEarnings(ticker: string): Promise<EstimatesAnswer> {
    this.earningsCalls.push(ticker);
    this.order.push(`EARNINGS:${ticker}`);
    return answerOf(this.earnings.replies?.[ticker] ?? this.earnings.fallback ?? { status: 'no-coverage' }, ticker);
  }
}

/** Two quarters of an invented consensus: the quarter that ended 30 Sep 2026 (EPS 2.10, revenue 5.1 billion) and the unreported one after it. */
export const SAMPLE_ESTIMATES: EstimatesAnswer = {
  status: 'ok',
  quarters: [
    { quarterEnd: '2026-12-31', eps: { average: 2.4, high: 2.6, low: 2.2, analysts: 10 }, revenue: { average: 5_400_000_000, high: 5_500_000_000, low: 5_300_000_000, analysts: 9 } },
    { quarterEnd: '2026-09-30', eps: { average: 2.1, high: 2.2, low: 2, analysts: 12 }, revenue: { average: 5_100_000_000, high: 5_200_000_000, low: 5_000_000_000, analysts: 11 } },
  ],
};

/** What the free `EARNINGS` function gives for the same company: the EPS estimate of the quarter that ended 30 Sep 2026 (2.10, reported 2.18) and one before. */
export const SAMPLE_EARNINGS: EstimatesAnswer = {
  status: 'ok',
  available: 80,
  quarters: [
    { quarterEnd: '2026-09-30', eps: { average: 2.1 }, reportedEps: 2.18, providerSurprise: 0.08 },
    { quarterEnd: '2026-06-30', eps: { average: 1.95 }, reportedEps: 2, providerSurprise: 0.05 },
  ],
};
