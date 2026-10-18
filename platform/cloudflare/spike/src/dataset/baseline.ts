/**
 * The baseline "demo-size" dataset: the REAL seed (services/api/scripts/seed.ts, imported, not edited) run against a
 * fake document client that captures the PutRequest items instead of calling DynamoDB.
 */
import { seed } from '../../../../../services/api/scripts/seed.js';
import { countByEntity, type Dataset, type Item } from './types.js';

export const SPIKE_TODAY = '2026-10-15';
export const SPIKE_USER = 'demo';

export async function buildBaseline(today = SPIKE_TODAY, userId = SPIKE_USER): Promise<Dataset> {
  const items: Item[] = [];
  // Only QueryCommand (stale seed keys) and BatchWriteCommand are used by seed(); they are told apart by class name.
  const doc = {
    send: (cmd: { constructor: { name: string }; input: { RequestItems?: Record<string, { PutRequest?: { Item: Item } }[]> } }) => {
      if (cmd.constructor.name === 'QueryCommand') return Promise.resolve({ Items: [] });
      for (const reqs of Object.values(cmd.input.RequestItems ?? {})) for (const r of reqs) if (r.PutRequest) items.push(r.PutRequest.Item);
      return Promise.resolve({});
    },
  };
  await seed({ doc: doc as never, tableName: 'spike', userId, today, log: () => undefined });
  return { name: 'baseline-demo', userId, today, items, counts: countByEntity(items) };
}
