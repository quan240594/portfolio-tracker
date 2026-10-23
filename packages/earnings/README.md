# @portfolio/earnings

Earnings summaries for the Cloudflare personal deployment: SEC press release in, verified scorecard and details out. Portable code
(no Cloudflare imports): the Worker wires the ports in `packages/cloudflare-app/src/earnings.ts`.

| Module | Role |
|---|---|
| `sec.ts` | SEC client: ticker to CIK, submissions, filing index, exhibit; declared User-Agent, token bucket, 403/429 as a block |
| `text.ts` | release HTML to plain text (tables as rows), capped at 60,000 characters |
| `ai.ts`, `schema.ts` | Workers AI port (`AiLike`), JSON-schema prompt, strict zod validation, neuron accounting, at most 2 calls per release |
| `numbers.ts`, `verify.ts` | verbatim matching of numbers, quotes and bullets; unverifiable values are dropped |
| `derive.ts`, `estimates.ts` | YoY, QoQ, beat/miss, FCF, FCF per share, margins computed by code; EPS estimate from Alpha Vantage |
| `select.ts`, `jobs.ts`, `pipeline.ts`, `service.ts` | which symbols to check, the `watchEarnings` / `fetchEarningsSummary` jobs, back-off, backfill, status and refresh |
| `repository.ts` | storage port (`TICKER#<symbol>` / `EARNSUM#<date>`, `EARNSTATE`) |
| `testing/` | six invented release fixtures, `FakeSec`, `FakeAi`, a harness (also used by the cloudflare-app suites) |

Everything is tested with fakes only (`pnpm --filter @portfolio/earnings test:coverage`); no test touches the SEC or Workers AI.
Design, limits and cost: `docs/architecture.md`, "Earnings summaries".
