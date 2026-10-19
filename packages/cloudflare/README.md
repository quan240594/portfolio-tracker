# @portfolio/cloudflare

The Cloudflare adapters of the platform ports (`@portfolio/platform`), built on the SQLite database and the alarm of one
**Durable Object**. Free-plan friendly: no D1, R2, Queues or paid binding.

| Port | Adapter | Storage |
|---|---|---|
| `ItemStore` | `SqlItemStore` | table `items(pk, sk, data)`, `WITHOUT ROWID`, primary key `(pk, sk)` |
| `SecretStore` | `SqlSecretStore` | table `secrets`, AES-256-GCM (WebCrypto), key from a Worker secret |
| `FileStore` | `SqlFileStore` | tables `files` (blobs up to 1.5 MiB) and `uploads` (single-use tokens) |
| `JobQueue` | `AlarmJobQueue` + `runAlarm` | tables `jobs`, `schedules`; the Durable Object alarm |

`createDurableObjectPlatform({ ctx, secretsKey, now, onUsage })` builds all of them; the Hub Durable Object calls it from its
constructor. See the "Cloudflare Durable Object adapters" section of [docs/architecture.md](../../docs/architecture.md).

## Tests

```bash
pnpm --filter @portfolio/cloudflare test            # unit tests + the contract suites in Node and in real workerd
pnpm --filter @portfolio/cloudflare test:coverage
```

- `src/*.test.ts` run the shared contract suites (`runItemStoreContract`, `runSecretStoreContract`, `runFileStoreContract`,
  `runJobQueueContract`) and the unit tests against real SQLite compiled to WebAssembly (`sql.js`), where coverage is measured.
- `test/workerd.test.ts` boots the same adapters inside a SQLite-backed Durable Object in the real workerd runtime
  (Miniflare, no network, no Cloudflare account) and runs the same contract suites through a JSON-RPC proxy.
