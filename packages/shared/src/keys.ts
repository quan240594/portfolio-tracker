/**
 * DynamoDB single-table design. Table has string keys PK + SK. No GSIs in v1.
 * Every item also has `entityType` and the entity's fields stored flat (numbers as DynamoDB N).
 *
 * | Entity          | PK                 | SK                        | entityType      |
 * |-----------------|--------------------|---------------------------|-----------------|
 * | Portfolio       | USER#{userId}      | PORTFOLIO#{portfolioId}   | PORTFOLIO       |
 * | Transaction     | USER#{userId}      | TXN#{portfolioId}#{date}#{id} | TRANSACTION |
 * | Import status   | USER#{userId}      | IMPORT#{importId}         | IMPORT          |
 * | User registry   | USERS              | USER#{userId}             | USER            |
 * | Tracked ticker  | TRACKED            | TICKER#{symbol}           | TRACKED_TICKER  |
 * | Latest quote    | TICKER#{symbol}    | QUOTE#LATEST              | QUOTE           |
 * | EOD close       | TICKER#{symbol}    | EOD#{date}                | EOD             |
 * | Profile         | TICKER#{symbol}    | PROFILE                   | PROFILE         |
 * | Dividend event  | TICKER#{symbol}    | DIV#{exDate}              | DIVIDEND_EVENT  |
 * | FX rates        | FX#{base}          | LATEST                    | FX              |
 * | FX daily fixing | FX#{base}          | DAY#{date}                | FX_DAY          |
 */
export const ENTITY = {
  portfolio: 'PORTFOLIO',
  transaction: 'TRANSACTION',
  import: 'IMPORT',
  user: 'USER',
  trackedTicker: 'TRACKED_TICKER',
  quote: 'QUOTE',
  eod: 'EOD',
  profile: 'PROFILE',
  dividendEvent: 'DIVIDEND_EVENT',
  fx: 'FX',
  fxDay: 'FX_DAY',
} as const;

export const keys = {
  user: (userId: string) => ({ PK: `USER#${userId}` }),
  portfolio: (userId: string, portfolioId: string) => ({ PK: `USER#${userId}`, SK: `PORTFOLIO#${portfolioId}` }),
  portfolioPrefix: 'PORTFOLIO#',
  transaction: (userId: string, portfolioId: string, date: string, id: string) => ({
    PK: `USER#${userId}`,
    SK: `TXN#${portfolioId}#${date}#${id}`,
  }),
  /** begins_with prefix for all transactions of a user (all portfolios). */
  transactionPrefix: 'TXN#',
  /** begins_with prefix for the transactions of one portfolio. */
  portfolioTransactionPrefix: (portfolioId: string) => `TXN#${portfolioId}#`,
  import: (userId: string, importId: string) => ({ PK: `USER#${userId}`, SK: `IMPORT#${importId}` }),
  userRegistry: (userId: string) => ({ PK: 'USERS', SK: `USER#${userId}` }),
  trackedTicker: (symbol: string) => ({ PK: 'TRACKED', SK: `TICKER#${symbol}` }),
  trackedPk: 'TRACKED',
  quote: (symbol: string) => ({ PK: `TICKER#${symbol}`, SK: 'QUOTE#LATEST' }),
  eod: (symbol: string, date: string) => ({ PK: `TICKER#${symbol}`, SK: `EOD#${date}` }),
  eodPrefix: 'EOD#',
  profile: (symbol: string) => ({ PK: `TICKER#${symbol}`, SK: 'PROFILE' }),
  dividendEvent: (symbol: string, exDate: string) => ({ PK: `TICKER#${symbol}`, SK: `DIV#${exDate}` }),
  dividendPrefix: 'DIV#',
  tickerPk: (symbol: string) => `TICKER#${symbol}`,
  fx: (base: string) => ({ PK: `FX#${base}`, SK: 'LATEST' }),
  fxDay: (base: string, date: string) => ({ PK: `FX#${base}`, SK: `DAY#${date}` }),
  fxDayPrefix: 'DAY#',
} as const;

/** S3 object key layout for CSV uploads; the ingest service parses userId/importId from it. */
export const importObjectKey = (userId: string, importId: string) => `imports/${userId}/${importId}.csv`;
export const parseImportObjectKey = (key: string): { userId: string; importId: string } | null => {
  const m = /^imports\/([^/]+)\/([^/]+)\.csv$/.exec(decodeURIComponent(key));
  return m ? { userId: m[1]!, importId: m[2]! } : null;
};
