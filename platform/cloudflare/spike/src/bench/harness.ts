import type { Deps, RouteContext } from '../../../../../services/api/src/deps.js';
import { matchRoute } from '../../../../../services/api/src/router.js';
import { buildBaseline } from '../dataset/baseline.ts';
import { buildHeavy } from '../dataset/heavy.ts';
import type { Dataset } from '../dataset/types.ts';
import { MemoryItemStore } from '../store/memory-store.ts';
import { ItemsRepository, DAY_LAYOUT, PACKED_LAYOUT, type RepoOptions } from '../store/items-repository.ts';
import { datasetToRows } from '../store/load-dataset.ts';

export type DatasetName = 'baseline' | 'heavy';
export interface Scenario {
  id: string;
  label: string;
  layout: RepoOptions;
  /** Model D1's result hand-over (an extra JSON round trip per result set). */
  wire: boolean;
}

/** `day-plain` = DynamoDB-shaped rows read from memory (the literal ask); `packed-d1` = the recommended layout + D1-style decode. */
export const SCENARIOS: Scenario[] = [
  { id: 'day-plain', label: 'row per day, in-memory rows', layout: DAY_LAYOUT, wire: false },
  { id: 'day-d1', label: 'row per day, + D1 result decode', layout: DAY_LAYOUT, wire: true },
  { id: 'packed-d1', label: 'row per symbol-year, + D1 result decode', layout: PACKED_LAYOUT, wire: true },
];

export const NOW = new Date('2026-10-15T12:00:00.000Z');

export async function buildDataset(name: DatasetName): Promise<Dataset> {
  return name === 'baseline' ? buildBaseline() : buildHeavy();
}

export interface Setup {
  ds: Dataset;
  store: MemoryItemStore;
  repo: ItemsRepository;
  deps: Deps;
}

export function setup(ds: Dataset, scenario: Scenario): Setup {
  const store = new MemoryItemStore({ wire: scenario.wire });
  store.load(datasetToRows(ds, scenario.layout));
  const repo = new ItemsRepository(store, scenario.layout);
  let n = 0;
  const deps: Deps = {
    repo,
    mgmt: repo,
    events: { transactionsChanged: () => Promise.resolve() },
    signer: { signCsvUpload: () => Promise.resolve('https://example.invalid/upload') },
    config: { baseCurrency: 'EUR', authMode: 'demo', demoUserId: ds.userId, corsAllowedOrigin: '*' },
    now: () => NOW,
    uuid: () => `spike-${++n}`,
  };
  return { ds, store, repo, deps };
}

export interface Case {
  id: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Writes change the store, so they are excluded from the repeat-N CPU table and only counted once. */
  write?: boolean;
}

/** Runs the handler path exactly like app.ts: route match -> handler -> serialise the response body. Returns bytes. */
export async function invoke(s: Setup, c: Case): Promise<{ status: number; bytes: number }> {
  const matched = matchRoute(c.method, c.path);
  const ctx: RouteContext = {
    deps: s.deps,
    userId: s.ds.userId,
    pathParams: matched.pathParams,
    query: c.query ?? {},
    body: c.body === undefined ? undefined : JSON.stringify(c.body),
    isBase64Encoded: false,
  };
  const res = await matched.handler(ctx);
  const text = res.body === undefined ? '' : res.contentType && typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  return { status: res.statusCode, bytes: text.length };
}
