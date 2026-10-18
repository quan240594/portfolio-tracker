/**
 * CPU of the CSV import path per row count (real ingest code: csv-parse + zod row validation) and of the oversell
 * replay; used to size the chunks of the resumable import job.   node --expose-gc --import tsx src/bench/import-cpu.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPositions, transactionsToCsv, type Transaction } from '../../../../../packages/shared/src/index.js';
import { parseImportCsv } from '../../../../../services/ingest/src/csv.js';
import { buildHeavy } from '../dataset/heavy.ts';

const ds = buildHeavy();
const txns = ds.items.filter((i) => i.entityType === 'TRANSACTION').map((i) => JSON.parse(JSON.stringify(i)) as Transaction);
const cpu = (fn: () => unknown, runs = 30) => {
  for (let i = 0; i < 5; i++) fn();
  (globalThis as { gc?: () => void }).gc?.();
  const s: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = process.cpuUsage();
    fn();
    const d = process.cpuUsage(t);
    s.push((d.user + d.system) / 1000);
  }
  s.sort((a, b) => a - b);
  return { median: Number(s[Math.floor(s.length / 2)]!.toFixed(2)), p95: Number(s[Math.ceil(0.95 * s.length) - 1]!.toFixed(2)) };
};
const out: Record<string, unknown> = { node: process.version, parse: {}, positions: {} };
for (const n of [25, 50, 100, 200, 500, 1500]) {
  const csv = transactionsToCsv(txns.slice(0, n));
  (out.parse as Record<string, unknown>)[`${n} rows (${(csv.length / 1024).toFixed(0)} KB)`] = cpu(() => parseImportCsv(csv));
}
for (const n of [100, 500, 1500]) (out.positions as Record<string, unknown>)[`buildPositions(${n} txns)`] = cpu(() => buildPositions(txns.slice(0, n)));
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'results');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `import-cpu-node${process.versions.node.split('.')[0]}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
