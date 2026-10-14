import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  DynamoBrokerStore,
  SecretsManagerCredentialStore,
  Trading212Client,
  awsCommon,
  createAwsDeps as createSyncDeps,
  createDocClient,
  createHandler as createSyncHandler,
  loadConfig as loadBrokerConfig,
  type BrokerStore,
  type CredentialStore,
} from '@portfolio/broker-sync';
import type { BrokerSyncEvent, Trading212Credentials } from '@portfolio/shared';
import type { Config } from './config.js';
import { logger } from './lib/logger.js';

/** Broker (Trading 212) collaborators of the API. Optional in Deps: routes answer 503 when it is not wired. */
export interface BrokerDeps {
  store: Pick<BrokerStore, 'getState' | 'listStates' | 'createState' | 'saveState' | 'deleteStates'>;
  /** Write side of the per-user secret; the API never reads a secret back. */
  credentials: Pick<CredentialStore, 'put' | 'delete'>;
  /** Calls Trading 212 once with the candidate credentials; resolves to the account currency, rejects with a BrokerError. */
  verify: (credentials: Trading212Credentials) => Promise<{ accountCurrency: string }>;
  /** Starts a sync without waiting for it. */
  invokeSync: (event: Extract<BrokerSyncEvent, { userId: string }>) => Promise<void>;
}

/** One quick attempt: the API Lambda has seconds, not minutes, and a rate-limit wait would only hide the error. */
export async function verifyWithTrading212(credentials: Trading212Credentials): Promise<{ accountCurrency: string }> {
  const summary = await new Trading212Client({ credentials, maxAttempts: 1, timeoutMs: 6000 }).accountSummary();
  return { accountCurrency: summary.currency.toUpperCase() };
}

/** Table and endpoint come from the API config; the secret prefix and sync function from the BROKER_* variables. */
export function createBrokerDeps(api: Pick<Config, 'tableName' | 'region' | 'endpointUrl'>): BrokerDeps {
  const config = { ...loadBrokerConfig(), ...api };
  const common = awsCommon(config);
  const invokeSync: BrokerDeps['invokeSync'] = config.syncFunctionName
    ? lambdaInvoker(new LambdaClient(common), config.syncFunctionName)
    : inProcessInvoker();
  return {
    store: new DynamoBrokerStore(createDocClient(config), config.tableName),
    credentials: new SecretsManagerCredentialStore(new SecretsManagerClient(common), config.secretPrefix),
    verify: verifyWithTrading212,
    invokeSync,
  };
}

export function lambdaInvoker(client: Pick<LambdaClient, 'send'>, functionName: string): BrokerDeps['invokeSync'] {
  return async (event) => {
    await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: JSON.stringify(event) }));
  };
}

/** Local development (no sync Lambda): runs the sync inside the API process. Failures land in the state item. */
function inProcessInvoker(): BrokerDeps['invokeSync'] {
  const handler = createSyncHandler(() => createSyncDeps(loadBrokerConfig()));
  return (event) => {
    handler(event).catch((err: unknown) => logger.error('Local sync failed', { error: (err as Error).name }));
    return Promise.resolve();
  };
}
