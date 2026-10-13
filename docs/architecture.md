# Architecture & cross-team contracts

Source of truth for conventions shared between `web/`, `services/*`, and `infra/`.
Domain types, API shapes, DynamoDB keys and event schemas live in code in
[`packages/shared/src`](../packages/shared/src) — this document covers everything else.

## Overview

```mermaid
flowchart LR
  subgraph Client
    W[React SPA<br/>CloudFront + S3]
  end
  W -- REST --> APIGW[API Gateway HTTP API]
  APIGW --> API[api Lambda<br/>TS]
  W -- presigned PUT --> S3[(S3 imports bucket)]
  S3 -- Object Created --> EBD[EventBridge default bus]
  EBD --> QI[[SQS ingest-queue]] --> ING[ingest Lambda<br/>TS]
  API -- TransactionsChanged --> BUS[EventBridge custom bus]
  ING -- TransactionsChanged --> BUS
  BUS --> QE[[SQS enrich-queue]] --> ENR[prices-enrich Lambda<br/>Python]
  SCH[EventBridge Scheduler] --> REF[prices-refresh Lambda<br/>Python]
  REF -- PricesUpdated --> BUS
  ENR -- PricesUpdated --> BUS
  API & ING & ENR & REF --> DDB[(DynamoDB single table)]
  ENR & REF --> MD[(Market data APIs)]
```

Every SQS queue has a DLQ (`maxReceiveCount = 3`). SQS-triggered Lambdas use
`ReportBatchItemFailures` (partial batch responses) and must be idempotent.

## Naming

`{app}-{component}-{env}` with `app = portfolio-tracker`, `env ∈ {local, dev, prod}`.

| Resource | Name |
|---|---|
| DynamoDB table | `portfolio-tracker-{env}` (PK/SK strings, PAY_PER_REQUEST) |
| Imports bucket | `portfolio-tracker-imports-{env}-{accountId}` (`portfolio-tracker-imports-local` locally) |
| Custom event bus | `portfolio-tracker-{env}` |
| Ingest queue / DLQ | `portfolio-tracker-ingest-{env}` / `…-ingest-dlq-{env}` |
| Enrich queue / DLQ | `portfolio-tracker-enrich-{env}` / `…-enrich-dlq-{env}` |
| Lambdas | `portfolio-tracker-api-{env}`, `…-ingest-{env}`, `…-prices-refresh-{env}`, `…-prices-enrich-{env}` |
| SSM params | `/portfolio-tracker/{env}/<provider>-api-key` (SecureString) |

## Environment variables (all Lambdas)

| Var | Used by | Notes |
|---|---|---|
| `TABLE_NAME` | all | |
| `EVENT_BUS_NAME` | api, ingest, prices | |
| `IMPORT_BUCKET` | api, ingest | |
| `BASE_CURRENCY` | api, prices | default `EUR` |
| `DEMO_USER_ID` | api | default `demo`; used when no JWT authorizer claim |
| `CORS_ALLOWED_ORIGIN` | api | |
| `LOG_LEVEL` | all | default `INFO` |
| `MARKET_DATA_PROVIDER` | prices | `mock` or a real provider id (see services/prices README) |
| `*_API_KEY_PARAM` | prices | SSM parameter name(s) holding provider API keys |
| `AWS_ENDPOINT_URL` | all (local only) | `http://localhost:4566` (LocalStack); both AWS SDK v3 and boto3 honour it |

## Build artifacts (consumed by Terraform)

| Service | Command | Artifact | Handler | Runtime |
|---|---|---|---|---|
| `services/api` | `pnpm --filter @portfolio/api package` | `services/api/dist/api.zip` | `index.handler` | nodejs20.x, arm64 |
| `services/ingest` | `pnpm --filter @portfolio/ingest package` | `services/ingest/dist/ingest.zip` | `index.handler` | nodejs20.x, arm64 |
| `services/prices` | `services/prices/scripts/package.sh` | `services/prices/dist/prices.zip` | `prices.handlers.scheduled_refresh` / `prices.handlers.on_transactions_changed` | python3.12, arm64 |

TS bundles: esbuild, ESM (`index.mjs`), `--platform=node --target=node20`, `@aws-sdk/*` external (provided by runtime).

## Symbols

Canonical symbols are Yahoo-style: US tickers bare (`AAPL`), exchange suffix otherwise
(`ASML.AS` Euronext Amsterdam, `SAP.DE` XETRA, `MC.PA` Paris, `VWRL.AS`), crypto `BTC-EUR`.
Market-data adapters map canonical ↔ provider symbols.

## CSV import format

Header (case-insensitive, any order): `date,type,symbol,quantity,price,fee,currency[,note]`.
Validated by `csvRowSchema`. Max 1 MB / 5000 rows. **All-or-nothing**: if any row fails validation
or the import would oversell a position, nothing is written and the import is `FAILED` with
row-level errors. Transaction ids from imports are deterministic (`{importId}-{rowNumber}`) so
SQS redelivery is idempotent.

## Local development

`docker compose up -d` starts LocalStack (dynamodb, s3, sqs, events, ssm). An init hook in
`infra/localstack/` creates the local table, bucket, bus, queues and an S3 → SQS notification
on the ingest queue (S3 *notification* shape locally vs. EventBridge shape in AWS — the ingest
handler accepts both). Then:

1. `pnpm --filter @portfolio/api seed` — demo user, transactions, profiles, 1y EOD prices, FX, dividend events.
2. `pnpm --filter @portfolio/api dev` — local HTTP server on `:3001` wrapping the Lambda handler.
3. `pnpm --filter @portfolio/ingest dev` — long-polls the local ingest queue and invokes the handler.
4. `pnpm --filter @portfolio/web dev` — Vite on `:5173`, proxies `/api/*` → `:3001` (prefix stripped).
5. Optional: `cd services/prices && python -m prices.local refresh` with `MARKET_DATA_PROVIDER=mock`.

## Known v1 limitations

- Cost basis is converted at the current FX rate (no historical FX), so FX effects are folded into returns.
- Single demo user unless a JWT authorizer (Cognito) is enabled.
