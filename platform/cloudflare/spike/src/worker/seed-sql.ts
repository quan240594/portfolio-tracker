/** Writes .wrangler/seed/seed-<dataset>.sql (packed layout) for `wrangler d1 execute DB --local --file ...`. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataset, type DatasetName } from '../bench/harness.ts';
import { PACKED_LAYOUT } from '../store/items-repository.ts';
import { SCHEMA } from '../store/item-store.ts';
import { datasetToRows } from '../store/load-dataset.ts';

const name = (process.argv[2] ?? 'baseline') as DatasetName;
const ds = await buildDataset(name);
const rows = datasetToRows(ds, PACKED_LAYOUT);
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const lines = [SCHEMA.trim()];
for (let i = 0; i < rows.length; i += 20) {
  lines.push(`INSERT OR REPLACE INTO items (pk, sk, data) VALUES ${rows.slice(i, i + 20).map((r) => `(${q(r.pk)},${q(r.sk)},${q(r.data)})`).join(',')};`);
}
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.wrangler', 'seed');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `seed-${name}.sql`), lines.join('\n'));
console.log(`seed-${name}.sql: ${rows.length} rows`);
