import type { JobQueue } from '@portfolio/platform';
import { Trading212Client, type BrokerStore, type CredentialStore } from '@portfolio/broker-sync';
import type { Trading212Credentials } from '@portfolio/shared';

/** Broker (Trading 212) collaborators of the API. Optional in Deps: routes answer 503 when it is not wired. */
export interface BrokerDeps {
  store: Pick<BrokerStore, 'getState' | 'listStates' | 'createState' | 'saveState' | 'deleteStates'>;
  /** Write side of the per-user secret; the API never reads a secret back. */
  credentials: Pick<CredentialStore, 'put' | 'delete'>;
  /** Calls Trading 212 once with the candidate credentials; resolves to the account currency, rejects with a BrokerError. */
  verify: (credentials: Trading212Credentials) => Promise<{ accountCurrency: string }>;
  /** Starts a sync without waiting for it (the `syncBroker` job). */
  jobs: JobQueue;
}

/** One quick attempt: the API Lambda has seconds, not minutes, and a rate-limit wait would only hide the error. */
export async function verifyWithTrading212(credentials: Trading212Credentials): Promise<{ accountCurrency: string }> {
  const summary = await new Trading212Client({ credentials, maxAttempts: 1, timeoutMs: 6000 }).accountSummary();
  return { accountCurrency: summary.currency.toUpperCase() };
}
