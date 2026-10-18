/** Stand-in for @portfolio/broker-sync: the API routes only need the error class (the sync engine itself runs elsewhere). */
export type BrokerErrorCode = string;
export class BrokerError extends Error {
  constructor(
    public readonly code: BrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}
