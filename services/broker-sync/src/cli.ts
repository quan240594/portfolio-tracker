/**
 * Local CLI: `pnpm --filter @portfolio/broker-sync sync -- --user demo --portfolio trading-212 [--dry-run] [--full] [--reconcile]`
 *           `pnpm --filter @portfolio/broker-sync sync -- --whoami`
 *
 * Credentials come from T212_API_KEY / T212_API_SECRET / T212_ENV, else from the file named by T212_ENV_FILE
 * (default: the nearest `.env.trading212.local`). `--dry-run` never touches AWS and writes nothing.
 * For LocalStack set AWS_ENDPOINT_URL (+ dummy AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) and TABLE_NAME/EVENT_BUS_NAME.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { awsCommon, createDocClient } from './clients.js';
import { loadConfig } from './config.js';
import { LocalCredentialSource, loadLocalCredentials, type LocalCredentialDeps } from './credentials.js';
import { BrokerError } from './errors.js';
import { EventBridgePublisher } from './events.js';
import { MemoryBrokerStore } from './memory-store.js';
import { formatResult, whoami } from './report.js';
import { DynamoBrokerStore } from './store.js';
import { runSync, type SyncDeps } from './sync.js';
import { Trading212Client } from './t212/client.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      user: { type: 'string', default: 'demo' },
      portfolio: { type: 'string', default: 'trading-212' },
      'dry-run': { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      reconcile: { type: 'boolean', default: false },
      whoami: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
  });
  if (values.whoami) {
    console.log(await whoami());
    return 0;
  }

  const config = loadConfig();
  const localDeps: LocalCredentialDeps = {
    env: process.env,
    cwd: process.cwd(),
    fileExists: existsSync,
    readFile: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
  };
  const credentials = new LocalCredentialSource(localDeps);
  const dryRun = values['dry-run'];
  const base = {
    credentials,
    createApi: (c: Parameters<SyncDeps['createApi']>[0]) =>
      new Trading212Client({ credentials: c, ...(values.verbose ? { onEvent: (e) => console.error(JSON.stringify(e)) } : {}) }),
    symbolOverrides: config.symbolOverrides,
    now: () => new Date(),
  };
  const deps: SyncDeps = dryRun
    ? { ...base, store: new MemoryBrokerStore(), events: { transactionsChanged: () => Promise.resolve() } }
    : {
        ...base,
        store: new DynamoBrokerStore(createDocClient(config), config.tableName),
        events: new EventBridgePublisher(new EventBridgeClient(awsCommon(config)), config.eventBusName),
      };

  // Fail early with a readable message instead of a confusing 401 on an empty key.
  const { environment } = loadLocalCredentials(localDeps);
  if (!dryRun) await deps.store.ensurePortfolio(values.user, values.portfolio, 'Trading 212', new Date().toISOString());
  const result = await runSync(deps, {
    userId: values.user,
    portfolioId: values.portfolio,
    full: values.full,
    reconcile: values.reconcile,
    dryRun,
    autoConnect: { environment },
  });
  console.log(formatResult(result));
  return result.status === 'SUCCEEDED' ? 0 : 1;
}

try {
  process.exit(await main());
} catch (err: unknown) {
  console.error(err instanceof BrokerError ? `${err.code}: ${err.message}` : `Unexpected error (${(err as Error).name})`);
  process.exit(2);
}
