import type { AlphaVantageEstimatesClient, EstimatesAnswer } from '@portfolio/prices';

/** A reply of the fake: an answer, an error to throw, or a function of the ticker. */
export type EstimatesReply = EstimatesAnswer | Error | ((ticker: string) => EstimatesAnswer);

/** The fake of the Alpha Vantage consensus client: answers per ticker (`fallback` for the others) and records every call. No network. */
export class FakeEstimates implements Pick<AlphaVantageEstimatesClient, 'fetchEstimates'> {
  readonly calls: string[] = [];

  constructor(
    private readonly replies: Readonly<Record<string, EstimatesReply>> = {},
    private readonly fallback: EstimatesReply = { status: 'no-coverage' },
  ) {}

  fetchEstimates(ticker: string): Promise<EstimatesAnswer> {
    this.calls.push(ticker);
    const reply = this.replies[ticker] ?? this.fallback;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(typeof reply === 'function' ? reply(ticker) : reply);
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
