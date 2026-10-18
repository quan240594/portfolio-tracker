import type { EodPrice, FxDay } from '../../../../../packages/shared/src/index.js';
import type { Dataset, Item } from '../dataset/types.ts';
import type { Row } from './item-store.ts';
import { packEod, packFx, toRow, type RepoOptions } from './items-repository.ts';

const KEY_ATTRS = new Set(['PK', 'SK', 'entityType']);
const strip = (item: Item): Record<string, unknown> => Object.fromEntries(Object.entries(item).filter(([k]) => !KEY_ATTRS.has(k)));

/** Converts the DynamoDB-shaped items of a dataset to `items` rows in the requested layout. */
export function datasetToRows(ds: Dataset, layout: RepoOptions): Row[] {
  const rows: Row[] = [];
  const eod = new Map<string, EodPrice[]>();
  const fx = new Map<string, FxDay[]>();
  for (const item of ds.items) {
    if (item.entityType === 'EOD' && layout.priceLayout === 'symbol-year') {
      const p = strip(item) as unknown as EodPrice;
      const k = `${p.symbol}|${p.date.slice(0, 4)}|${p.currency}`;
      (eod.get(k) ?? eod.set(k, []).get(k)!).push(p);
    } else if (item.entityType === 'FX_DAY' && layout.fxLayout === 'year') {
      const d = strip(item) as unknown as FxDay;
      const k = d.date.slice(0, 4);
      (fx.get(k) ?? fx.set(k, []).get(k)!).push(d);
    } else {
      rows.push(toRow(item.PK, item.SK, strip(item)));
    }
  }
  for (const [k, list] of eod) {
    const [symbol, year, currency] = k.split('|') as [string, string, string];
    rows.push(toRow(`TICKER#${symbol}`, `EOD#${year}`, packEod(symbol, currency, year, list)));
  }
  for (const [year, list] of fx) rows.push(toRow('FX#EUR', `DAY#${year}`, packFx('EUR', list)));
  return rows;
}
