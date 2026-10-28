# @portfolio/earnings

Earnings summaries for the Cloudflare personal deployment: SEC press release in, verified scorecard and details out. Portable code
(no Cloudflare imports): the Worker wires the ports in `packages/cloudflare-app/src/earnings.ts`.

| Module | Role |
|---|---|
| `sec.ts` | SEC client: ticker table, submissions, filing index, exhibit choice and results check (a 6-K is scored on its first 3,000 characters); declared User-Agent, token bucket, 403/429 and the HTML rate-limit page as a block |
| `tickers.ts` | symbol to CIK: ticker, ticker without suffix, curated alias table (Xetra spellings), company name |
| `text.ts` | release HTML to plain text (tables as rows; inline-XBRL headers and hidden blocks dropped), capped at 48,000 characters |
| `ai.ts`, `schema.ts` | Workers AI port (`AiLike`), a prompt that shows the JSON shape, JSON mode first and plain text second, lenient reading, context-refusal retry, neuron accounting, at most 2 calls per release |
| `numbers.ts`, `verify.ts` | verbatim matching of numbers, quotes and bullets; unverifiable values are dropped |
| `derive.ts`, `estimates.ts` | YoY, QoQ, beat/miss, FCF, FCF per share, margins computed by code; EPS estimate from Alpha Vantage `EARNINGS` at the time of the release |
| `estimates-job.ts` | the `earningsEstimates` job: analyst consensus (EPS, revenue) of the held companies from Alpha Vantage `EARNINGS_ESTIMATES`, ordered by need, at most 8 calls a day and 3 a run, outcome per symbol (`ok`, `no-coverage`, `premium`, `rate-limited`, `error`) |
| `select.ts`, `jobs.ts`, `pipeline.ts`, `common.ts`, `store.ts` | which symbols to check, the `watchEarnings` / `fetchEarningsSummary` jobs, back-off, the structured `lastRun` of every outcome, storing with QoQ recomputation |
| `backfill.ts` | the `backfillEarnings` job: the latest N quarters of every holding, newest first across companies, resumable, within the daily AI allowance |
| `service.ts` | status (with `lastRun`, backfill progress, last full pass), refresh and "Fetch all now" (rescan of the current holdings) |
| `repository.ts` | storage port (`TICKER#<symbol>` / `EARNSUM#<date>`, `EARNSTATE`, consensus `EARNEST#<quarterEnd>` and `EARNEST#STATE`) |
| `testing/` | eleven invented release fixtures (six plain, five messy), `FakeSec` (also the HTML rate-limit page, per-URL statuses, one-off rejections), `FakeAi`, a harness (also used by the cloudflare-app suites) |

Everything is tested with fakes only (`pnpm --filter @portfolio/earnings test:coverage`); no test touches the SEC or Workers AI.
Design, limits and cost: `docs/architecture.md`, "Earnings summaries".
