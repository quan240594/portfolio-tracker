import { mapT212Symbol, type SymbolMapping, type T212InstrumentRef } from '@portfolio/shared';
import type { Trading212Api } from './t212/client.js';

/** ticker -> exchange name, from the instruments + exchanges metadata (1 request per 50 s, so loaded at most once). */
export async function loadExchangeNames(api: Pick<Trading212Api, 'instruments' | 'exchanges'>): Promise<Map<string, string>> {
  const [instruments, exchanges] = await Promise.all([api.instruments(), api.exchanges()]);
  const bySchedule = new Map<number, string>();
  for (const exchange of exchanges) for (const schedule of exchange.workingSchedules) bySchedule.set(schedule.id, exchange.name);
  const byTicker = new Map<string, string>();
  for (const { ticker, workingScheduleId } of instruments) {
    const name = workingScheduleId === undefined ? undefined : bySchedule.get(workingScheduleId);
    if (name !== undefined) byTicker.set(ticker, name);
  }
  return byTicker;
}

const NEEDS_EXCHANGE = new Set(['AMBIGUOUS_LISTING', 'NO_PATTERN']);

/**
 * Resolves every distinct instrument once. The (rate-limited) metadata is only fetched when some instrument cannot
 * be resolved from its ticker shape / ISIN alone; a metadata failure leaves those instruments unmapped.
 */
export async function resolveSymbols(
  refs: readonly T212InstrumentRef[],
  overrides: Readonly<Record<string, string>>,
  loadExchanges: () => Promise<Map<string, string>>,
): Promise<Map<string, SymbolMapping>> {
  const result = new Map<string, SymbolMapping>();
  const unresolved: T212InstrumentRef[] = [];
  for (const ref of refs) {
    if (result.has(ref.ticker)) continue;
    const mapping = mapT212Symbol(ref, overrides);
    result.set(ref.ticker, mapping);
    if (!mapping.ok && NEEDS_EXCHANGE.has(mapping.reason)) unresolved.push(ref);
  }
  if (unresolved.length === 0) return result;
  const exchanges = await loadExchanges().catch(() => new Map<string, string>());
  for (const ref of unresolved) {
    const exchange = exchanges.get(ref.ticker);
    if (exchange === undefined) continue;
    const mapping = mapT212Symbol({ ...ref, exchange }, overrides);
    if (mapping.ok) result.set(ref.ticker, mapping);
  }
  return result;
}
