# @portfolio/api

Single Lambda (`portfolio-tracker-api-{env}`) behind an API Gateway HTTP API (payload 2.0, `$default` route).
Routes are the `API_ROUTES` contract in `@portfolio/shared`; calculations come from the shared package.

```
src/index.ts        Lambda entry (index.handler): composes the AWS adapters once per container
src/lambda/         API Gateway (payload 2.0) <-> portable request/response; the only place that knows the event shape
src/portable.ts     platform-neutral surface (createApp, repositories, deps) for any other adapter, e.g. a Worker
src/clients.ts      AWS composition: DynamoDB ItemStore, EventBridge, S3 presigned uploads, Secrets Manager + Lambda (via @portfolio/aws)
src/app.ts          createApp: PortableRequest -> router -> route handler -> PortableResponse (error mapping, CORS, logging)
src/router.ts       matches API_ROUTES (strips trailing slash and an optional /api prefix)
src/routes/*        portfolios (CRUD + read scope) | portfolio | holdings | allocation | history | dividends | transactions | imports | brokers (Trading 212 connect/status/sync/disconnect, see docs/architecture.md)
src/repository.ts   domain repository on the ItemStore port: key scheme, item shapes and queries, written once for every storage adapter
src/management-repository.ts  the same for settings, categories, custom assets, watchlist and goals
src/local.ts        local HTTP server on :3001 serving the portable app
scripts/seed.ts     idempotent LocalStack seed for user `demo`: portfolios `default` (Main portfolio, EUR) and `trading-212`
                    (Trading 212, USD stocks) plus daily ECB fixings FX_DAY for USD/GBP/CHF
```

## Portfolios

Every transaction belongs to one portfolio (`USER#{userId}` / `PORTFOLIO#{id}`; transactions under `TXN#{portfolioId}#{date}#{id}`).
`GET /portfolios` creates `default` ("Main portfolio") for a user without any (conditional put, so concurrent first
requests are idempotent); writes and `?portfolioId=default` reads do the same on first use. Names are unique per user
(case-insensitive, `409 CONFLICT`), at most `MAX_PORTFOLIOS` (`422`). `DELETE /portfolios/{id}` answers `409 PORTFOLIO_NOT_EMPTY`
(details `{ transactionCount }`) unless `?force=true`, which batch-deletes the transactions and publishes
`TransactionsChanged` (reason `DELETED`); the only portfolio cannot be deleted (`409 LAST_PORTFOLIO`).

Read endpoints accept `?portfolioId=` (omitted or `all` = every portfolio combined; unknown = 404). `POST /transactions`
and `POST /imports` require `portfolioId`. Overselling is validated within the target portfolio; a symbol must use the
same currency in all portfolios of the user (`422` otherwise).

## Currency conversion

Every amount is reported in the base currency (`BASE_CURRENCY`, default `DEFAULT_BASE_CURRENCY` = EUR).
Portfolio, holdings, allocation, history and dividends load the latest rates (`FX#{base}` / `LATEST`) plus the
daily ECB fixings (`FX#{base}` / `DAY#{date}`) from 7 days before the first transaction in scope until today. Each
transaction is converted at its broker-applied `fxRate` if present, else at the fixing of its trade date (the previous
business day's for weekends/holidays), else at the latest rate. Market values use the latest rate; the resulting FX
part of the unrealized P&L is reported as `currencyEffect`. Without a `LATEST` item the newest fixing is used; without
any FX data only base-currency portfolios work (`FX_UNAVAILABLE` otherwise). `POST /transactions` accepts an optional
`fxRate` (units of the transaction currency per 1 unit of base currency, > 0), stored and returned with the transaction.

Errors use `{ error: { code, message, details? } }`: `VALIDATION_ERROR` 400, `NOT_FOUND` 404,
`CONFLICT` / `PORTFOLIO_NOT_EMPTY` / `LAST_PORTFOLIO` 409, `UNPROCESSABLE` 422 (oversell / mixed currency / portfolio limit),
`FX_UNAVAILABLE` 503, `INTERNAL_ERROR` 500.

## Environment

`TABLE_NAME`, `EVENT_BUS_NAME`, `IMPORT_BUCKET`, `BASE_CURRENCY` (EUR), `AUTH_MODE` (`cognito` when unset;
`pnpm dev` sets `demo`), `DEMO_USER_ID` (demo, `AUTH_MODE=demo` only), `CORS_ALLOWED_ORIGIN`, `LOG_LEVEL` (INFO), `AWS_ENDPOINT_URL` (local only).

## Authentication

In `AUTH_MODE=cognito` the user id is the API Gateway JWT authorizer's `sub` claim; requests without it get
`401 UNAUTHENTICATED` (`src/lib/auth.ts`). `AUTH_MODE=demo` (local dev/tests) falls back to `DEMO_USER_ID`.
Handlers must only use `ctx.userId`. See docs/architecture.md "Authentication".

## Scripts

| Command | What |
|---|---|
| `pnpm --filter @portfolio/api seed` | seed LocalStack (`docker compose up -d` first) |
| `pnpm --filter @portfolio/api dev` | local server on http://localhost:3001 (`PORT` to override) |
| `pnpm --filter @portfolio/api test` | unit tests (no AWS needed) |
| `LOCALSTACK=1 pnpm --filter @portfolio/api test:integration` | LocalStack tests (isolated, auto-created resources; set `AWS_ENDPOINT_URL` for a non-default port) |
| `pnpm --filter @portfolio/api package` | `dist/api/index.mjs` + `dist/api.zip` (handler `index.handler`) |

`typecheck` and `lint` are also available.
