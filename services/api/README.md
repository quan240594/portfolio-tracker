# @portfolio/api

Single Lambda (`portfolio-tracker-api-{env}`) behind an API Gateway HTTP API (payload 2.0, `$default` route).
Routes are the `API_ROUTES` contract in `@portfolio/shared`; calculations come from the shared package.

```
src/index.ts        Lambda entry (index.handler) – creates AWS clients once per container
src/app.ts          request → router → route handler, error mapping, CORS, structured logging
src/router.ts       matches API_ROUTES (strips trailing slash and an optional /api prefix)
src/routes/*        portfolio | holdings | allocation | history | dividends | transactions | imports
src/repository.ts   DynamoDB single-table access (DocumentClient)
src/events.ts       EventBridge TransactionsChanged publisher (source portfolio.api)
src/presigner.ts    S3 presigned PUT URLs for CSV imports
src/local.ts        local HTTP server on :3001 wrapping the handler
scripts/seed.ts     idempotent LocalStack seed for user `demo` (incl. daily ECB fixings FX_DAY for USD/GBP/CHF)
```

## Currency conversion

Every amount is reported in the base currency (`BASE_CURRENCY`, default `DEFAULT_BASE_CURRENCY` = EUR).
Portfolio, holdings, allocation, history and dividends load the latest rates (`FX#{base}` / `LATEST`) plus the
daily ECB fixings (`FX#{base}` / `DAY#{date}`) from 7 days before the first transaction until today. Each
transaction is converted at its broker-applied `fxRate` if present, else at the fixing of its trade date (the previous
business day's for weekends/holidays), else at the latest rate. Market values use the latest rate; the resulting FX
part of the unrealized P&L is reported as `currencyEffect`. Without a `LATEST` item the newest fixing is used; without
any FX data only base-currency portfolios work (`FX_UNAVAILABLE` otherwise). `POST /transactions` accepts an optional
`fxRate` (units of the transaction currency per 1 unit of base currency, > 0), stored and returned with the transaction.

Errors use `{ error: { code, message, details? } }`: `VALIDATION_ERROR` 400, `NOT_FOUND` 404,
`UNPROCESSABLE` 422 (oversell / mixed currency), `FX_UNAVAILABLE` 503, `INTERNAL_ERROR` 500.

## Environment

`TABLE_NAME`, `EVENT_BUS_NAME`, `IMPORT_BUCKET`, `BASE_CURRENCY` (EUR), `DEMO_USER_ID` (demo),
`CORS_ALLOWED_ORIGIN`, `LOG_LEVEL` (INFO), `AWS_ENDPOINT_URL` (local only).

## Scripts

| Command | What |
|---|---|
| `pnpm --filter @portfolio/api seed` | seed LocalStack (`docker compose up -d` first) |
| `pnpm --filter @portfolio/api dev` | local server on http://localhost:3001 (`PORT` to override) |
| `pnpm --filter @portfolio/api test` | unit tests (no AWS needed) |
| `LOCALSTACK=1 pnpm --filter @portfolio/api test:integration` | LocalStack tests (isolated, auto-created resources; set `AWS_ENDPOINT_URL` for a non-default port) |
| `pnpm --filter @portfolio/api package` | `dist/api/index.mjs` + `dist/api.zip` (handler `index.handler`) |

`typecheck` and `lint` are also available.
