# @portfolio/ingest

SQS-triggered Lambda (`portfolio-tracker-ingest-{env}`, `ReportBatchItemFailures`) that imports uploaded CSVs.

Each SQS message body is either an EventBridge S3 `Object Created` event (AWS) or an S3 event notification
(LocalStack). For every `imports/{userId}/{importId}.csv` object:

1. Load the `IMPORT` item; `COMPLETED`/`FAILED` → acknowledge (idempotent). Conditionally set `PROCESSING`.
2. Read the object (max 1 MB), parse with `csv-parse` (case-insensitive header, any order), validate every row
   with `csvRowSchema` (max 5000 rows) and replay existing + imported transactions with `buildPositions`.
3. Any problem → `FAILED` with `errors[]` (row numbers 1-based excluding header, row 0 = file-level; capped at 100); nothing is written.
4. Otherwise BatchWrite transactions (ids `{importId}-{row}`), upsert `USERS` / `TRACKED` items, publish
   `TransactionsChanged` (source `portfolio.ingest`, reason `IMPORTED`) and set `COMPLETED`.

Transient errors (throttling, network, PutEvents failures) are thrown and reported as batch item failures so SQS retries.

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
