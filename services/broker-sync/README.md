# @portfolio/broker-sync

Read-only import of the owner's own Trading 212 account into one portfolio. Design, data model, mapping rules and
verified API behaviour: [docs/architecture.md → "Trading 212 sync"](../../docs/architecture.md).

```
src/index.ts        Lambda entry point (EventBridge Scheduler {"all":true}, API invoke {userId, portfolioId, full?})
src/lib.ts          surface the API imports (client, stores, credential store, errors) – never the entry point
src/sync.ts         one run: lock → fetch → map → validate → write changed → event → state
src/mapper.ts       T212 order / dividend / split → Transaction (pure)
src/symbols.ts      ticker/ISIN/exchange → Yahoo-style symbol (rules live in packages/shared/src/broker-symbols.ts)
src/reconcile.ts    open positions of Trading 212 vs positions replayed from the imported transactions
src/t212/           typed fetch client (Basic auth, timeouts, retries, rate limits, pagination) + tolerant zod schemas
src/credentials.ts  Secrets Manager store (per user) and the local env/file source for the CLI
src/store.ts        DynamoDB persistence (state item, transactions, tracked tickers); memory-store.ts for dry runs/tests
src/cli.ts          local CLI
```

## CLI

```bash
# credentials: T212_API_KEY / T212_API_SECRET / T212_ENV, else the gitignored .env.trading212.local
# (nearest one above the working directory, or the file named by T212_ENV_FILE)
pnpm --filter @portfolio/broker-sync sync -- --whoami      # prints only this machine's public IPv4 (no credentials sent)
pnpm --filter @portfolio/broker-sync sync -- --dry-run     # fetch + map + validate; prints counts, symbols, UNMAPPED list
pnpm --filter @portfolio/broker-sync sync -- --user demo --portfolio trading-212 [--full] [--reconcile] [--verbose]
```

`--dry-run` never touches AWS. A real run needs LocalStack (`AWS_ENDPOINT_URL`, dummy AWS keys, `TABLE_NAME`,
`EVENT_BUS_NAME`). `--verbose` prints request diagnostics (endpoint, status, rate-limit headers) – never credentials.
Auth rejections (401/403) stop the run with `T212_AUTH_REJECTED`; nothing is retried.

## Environment (Lambda)

| Var | Notes |
|---|---|
| `TABLE_NAME`, `EVENT_BUS_NAME` | as for the other Lambdas |
| `BROKER_SECRET_PREFIX` | `/portfolio-tracker/{env}/broker/trading212` (secret per user below it) |
| `T212_SYMBOL_OVERRIDES` | optional JSON `{ "<T212 ticker or ISIN>": "<symbol>" }` |
| `BROKER_SYNC_FUNCTION` | API only: name of this Lambda; unset locally, where the API runs the sync in-process |

## Security notes

- Credentials are only accepted by `PUT /brokers/trading212`, stored in Secrets Manager and read by this Lambda; they
  are never logged, returned or kept in the browser. Error messages, state and logs carry codes and counts only.
- Never commit `.env.trading212.local` (gitignored) or put real credentials in tests/fixtures: tests use synthetic data
  shaped after the public OpenAPI spec (`src/testing/fixtures.ts`).
