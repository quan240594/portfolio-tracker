# @portfolio/ingest

SQS-triggered Lambda (`portfolio-tracker-ingest-{env}`, `ReportBatchItemFailures`) that imports uploaded CSVs.

Each SQS message body is either an EventBridge S3 `Object Created` event (AWS) or an S3 event notification
(LocalStack). For every `imports/{userId}/{importId}.csv` object:

1. Load the `IMPORT` item; `COMPLETED`/`FAILED` → acknowledge (idempotent). Conditionally set `PROCESSING`.
   The item's `portfolioId` is the target portfolio of every row; a missing id or a portfolio that no longer exists
   fails the import (row 0).
2. Read the object (max 1 MB), parse with `csv-parse` (case-insensitive header, any order; unknown columns ignored, duplicate columns rejected;
   blank lines ignored), validate every row with `csvRowSchema` (max 5000 rows), check that each symbol keeps the currency it has in any of
   the user's portfolios (first offending row is reported), and replay the target portfolio's existing + imported
   transactions with `buildPositions` (oversell).
   Every row must have exactly as many fields as the header; otherwise the row is reported as
   `Expected N fields but found M` (values containing commas, e.g. notes, must be quoted: `"bought dip, again"`).
3. Any problem → `FAILED` with `errors[]` (row numbers 1-based excluding header, row 0 = file-level; capped at 100); nothing is written.
4. Otherwise BatchWrite transactions (ids `{importId}-{row}`, keys `TXN#{portfolioId}#{date}#{id}`), upsert `USERS` / `TRACKED` items, publish
   `TransactionsChanged` (source `portfolio.ingest`, reason `IMPORTED`, with `portfolioId`) and set `COMPLETED`.

Transient errors (throttling, network, PutEvents failures) are thrown and reported as batch item failures so SQS retries.

## CSV format

Header names are case-insensitive and order-independent (`CSV_COLUMNS` in `@portfolio/shared`):

| Column | Required | Notes |
|---|---|---|
| `date` | yes | `YYYY-MM-DD` |
| `type` | yes | `BUY`, `SELL` or `DIVIDEND` (any case) |
| `symbol` | yes | upper-cased, e.g. `AAPL`, `VWRL.AS` |
| `quantity` | yes | > 0 (units; eligible units for dividends) |
| `price` | yes | ≥ 0, in `currency` (gross dividend per unit for dividends) |
| `fee` | yes (value may be empty → 0) | ≥ 0 (withholding tax for dividends) |
| `currency` | yes | ISO-4217, e.g. `USD` |
| `note` | no | max 500 chars; quote it when it contains commas |
| `fxRate` | no (value may be empty) | > 0. Broker-applied rate in units of `currency` per 1 EUR (e.g. `1.0842` for USD). Stored on the transaction and used instead of the ECB fixing of the trade date; leave empty to use the ECB rate. |

```csv
date,type,symbol,quantity,price,fee,currency,note,fxRate
2025-03-03,BUY,AAPL,5,150,1,USD,broker rate,1.0842
2025-03-04,BUY,MSFT,2,400,1,USD,ECB rate,
2025-03-05,BUY,VWRL.AS,10,110,2,EUR,,
```

## Environment

`TABLE_NAME`, `EVENT_BUS_NAME`, `IMPORT_BUCKET`, `LOG_LEVEL`, `AWS_ENDPOINT_URL` (local only).

## Scripts

| Command | What |
|---|---|
| `pnpm --filter @portfolio/ingest dev` | long-poll `portfolio-tracker-ingest-local` on LocalStack and invoke the handler |
| `pnpm --filter @portfolio/ingest test` | unit tests |
| `LOCALSTACK=1 pnpm --filter @portfolio/ingest test:integration` | S3 upload → S3 notification → SQS → handler against LocalStack |
| `pnpm --filter @portfolio/ingest package` | `dist/ingest/index.mjs` + `dist/ingest.zip` (handler `index.handler`) |

`typecheck` and `lint` are also available.
