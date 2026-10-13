# services/prices — market-data service (Python)

Two Lambdas (python3.12, arm64) sharing one zip:

| Handler | Trigger | Does |
|---|---|---|
| `prices.handlers.scheduled_refresh` | EventBridge Scheduler (cron) | FX + latest quotes for all tracked tickers → `QUOTE#LATEST`, today's `EOD#{date}`, `FX#{base}`; emits `PricesUpdated` (`trigger: "scheduled"`) |
| `prices.handlers.on_transactions_changed` | SQS enrich-queue (EventBridge `TransactionsChanged` envelopes), `ReportBatchItemFailures` | For symbols without a `PROFILE`: profile, 1y EOD, dividends (2y back + announced), latest quote, `TRACKED` item; emits `PricesUpdated` (`trigger: "enrichment"`) |

DynamoDB items, event shapes and field names mirror `packages/shared/src/{keys,types,events}.ts` exactly
(camelCase attributes, numbers stored as `N`/`Decimal`). See [`prices/keys.py`](prices/keys.py).

## Providers

`MARKET_DATA_PROVIDER` selects the implementation of the `MarketDataProvider` protocol
(`get_quotes`, `get_eod_history`, `get_profile`, `get_dividends`):

- **`mock`** (default) — offline, deterministic: seeded (SHA-256 of the symbol) mean-reverting random walk,
  currency by suffix, curated profiles for `AAPL, MSFT, ASML.AS, VWRL.AS, IWDA.AS, SAP.DE, BTC-EUR`, quarterly
  dividends for payers. FX uses fixed mock rates unless `FX_PROVIDER=frankfurter`.
- **`live`** — `RoutingProvider` composing the free-tier providers below. A provider is only constructed if its
  API key resolves; symbols routed to a missing provider are logged and skipped (never crash the run).

### Symbol routing (canonical symbols are Yahoo-style)

| Symbol | Example | Quotes / EOD | Profile | Dividends |
|---|---|---|---|---|
| crypto `^[A-Z0-9]+-[A-Z]{3}$` | `BTC-EUR` | CoinGecko | CoinGecko (static name map) | none |
| exchange suffix | `ASML.AS`, `SAP.DE`, `MC.PA` | EODHD | EODHD search | EODHD |
| bare (US) | `AAPL`, `BRK-B` | Twelve Data | Alpha Vantage → Twelve Data fallback | EODHD |

Provider symbol mapping: EODHD `ASML.AS→ASML.AS`, `SAP.DE→SAP.XETRA`, `VOD.L→VOD.LSE`, `AAPL→AAPL.US`;
Twelve Data `BRK-B→BRK.B`; CoinGecko `BTC→bitcoin`, `ETH→ethereum`, `SOL→solana`, … (extend with
`COINGECKO_COIN_IDS="AVAX=avalanche-2,LINK=chainlink"`). FX: Frankfurter (ECB) `GET /v1/latest?base=EUR`, no key.

### Free-tier quotas & how the service stays inside them

| Provider | Quota | Client-side guard |
|---|---|---|
| Twelve Data | 8 credits/min, 800/day (1 credit per symbol) | token bucket 8/min, daily counter, `/quote` batches ≤ 8 symbols |
| EODHD | ~20 calls/day (each ticker in a batch counts) | daily counter (`EODHD_DAILY_LIMIT`, default 20); EU quotes only refreshed in `EU_REFRESH_HOURS` or when > 24h old |
| CoinGecko demo | 30 calls/min, 10k/month | token bucket; one `/simple/price` call for all coins |
| Alpha Vantage | 25 calls/day, 5/min | profile-only; daily counter (`ALPHAVANTAGE_DAILY_LIMIT`) + bucket |

Counters are per Lambda container (best effort); provider-side 429s are retried with exponential backoff +
jitter (also on 5xx/network errors), honouring `Retry-After`. API keys are sent as headers where the provider
allows it, and query strings are redacted (`apikey=***`) in all logs and error messages.

Error semantics in the enrich Lambda: throttling / 5xx / DynamoDB errors → message returned in
`batchItemFailures` (retried, DLQ after 3 receives); unknown symbol or missing API key → logged and acked.
The `PROFILE` item is written last and acts as the "enriched" marker, so redelivery is idempotent.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `TABLE_NAME` | `portfolio-tracker-local` | |
| `EVENT_BUS_NAME` | `portfolio-tracker-local` | |
| `BASE_CURRENCY` | `EUR` | FX item is `FX#{BASE_CURRENCY}` / `LATEST` |
| `MARKET_DATA_PROVIDER` | `mock` | `mock` \| `live` |
| `FX_PROVIDER` | `mock` if provider is mock, else `frankfurter` | `mock` \| `frankfurter` |
| `EU_REFRESH_HOURS` | `18` | comma list of Europe/Amsterdam hours in which suffixed symbols are refreshed |
| `TWELVEDATA_API_KEY_PARAM`, `EODHD_API_KEY_PARAM`, `COINGECKO_API_KEY_PARAM`, `ALPHAVANTAGE_API_KEY_PARAM` | – | SSM SecureString names (GetParameter WithDecryption, cached per container) |
| `TWELVEDATA_API_KEY`, `EODHD_API_KEY`, `COINGECKO_API_KEY`, `ALPHAVANTAGE_API_KEY` | – | direct value, overrides the SSM param (local use) |
| `EODHD_DAILY_LIMIT`, `ALPHAVANTAGE_DAILY_LIMIT` | `20`, `25` | client-side daily budgets |
| `COINGECKO_COIN_IDS` | – | extra `TICKER=coingecko-id` pairs |
| `LOG_LEVEL` | `INFO` | JSON logs via stdlib `logging` |
| `AWS_ENDPOINT_URL` | – | LocalStack (`http://localhost:4566`) |

IAM needed: `dynamodb:Query/GetItem/BatchGetItem/PutItem/BatchWriteItem` on the table, `events:PutEvents` on the
bus, `ssm:GetParameter` (+ `kms:Decrypt` for the key) on the `*-api-key` params, SQS consume on the enrich queue.

### Setting API keys

```bash
env=dev
aws ssm put-parameter --type SecureString --overwrite --name /portfolio-tracker/$env/twelvedata-api-key   --value '<key>'
aws ssm put-parameter --type SecureString --overwrite --name /portfolio-tracker/$env/eodhd-api-key        --value '<key>'
aws ssm put-parameter --type SecureString --overwrite --name /portfolio-tracker/$env/coingecko-api-key    --value '<key>'
aws ssm put-parameter --type SecureString --overwrite --name /portfolio-tracker/$env/alphavantage-api-key --value '<key>'
```

and set `MARKET_DATA_PROVIDER=live` plus the four `*_API_KEY_PARAM` env vars on both Lambdas.

## Development

```bash
cd services/prices
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/pytest -q --cov=prices          # moto + fake urllib, no network; fails under 85% coverage
scripts/package.sh                         # -> dist/prices.zip (prices/ at zip root, reproducible)
```

The zip contains only the `prices/` package: runtime dependencies are the stdlib plus boto3 from the Lambda
runtime (`requirements.txt` is intentionally empty; if it ever lists packages, `package.sh` installs them for
`manylinux2014_aarch64` / cp312).

### Local run against LocalStack

With `docker compose up -d` (LocalStack + init hook creating the table/bus):

```bash
.venv/bin/python -m prices.local refresh                    # scheduled_refresh for all TRACKED tickers
.venv/bin/python -m prices.local refresh AAPL ASML.AS --all-hours   # track symbols first, ignore EU gating
.venv/bin/python -m prices.local enrich AAPL BTC-EUR VWRL.AS        # simulate a TransactionsChanged message
```

Defaults: `AWS_ENDPOINT_URL=http://localhost:4566`, `TABLE_NAME`/`EVENT_BUS_NAME=portfolio-tracker-local`,
region `eu-west-1`, dummy credentials, `MARKET_DATA_PROVIDER=mock`; any env var you set wins.
