/**
 * From a held symbol to the company's SEC registration (CIK). The app's symbols are Yahoo-style: a US ticker (`MSFT`), or a listing at
 * another exchange with a suffix (`ASML.AS`, `FOO.DE`). Four routes, in this order, each checked against the holding's name where there is one:
 * the ticker itself; the ticker without its exchange suffix; a curated alias table (German listings use their own spellings: `FOO.DE` is
 * Salesforce, `M4I.DE` Mastercard); and the company name against the SEC's titles (a foreign issuer that files 6-Ks through its ADR).
 */
import { TICKER_ALIASES, significantWords } from '@portfolio/shared';

export interface TickerEntry {
  cik: string;
  title: string;
}

export type TickerTable = ReadonlyMap<string, TickerEntry>;

export interface TickerMatch {
  cik: string;
  via: 'ticker' | 'alias' | 'name';
}

export interface TickerQuery {
  symbol: string;
  name?: string;
  /** Only the country prefix is used: `US...` makes a looser name match acceptable. */
  isin?: string;
}

export { TICKER_ALIASES, significantWords };

const sharesWord = (title: string, wanted: ReadonlySet<string>): boolean => significantWords(title).some((word) => wanted.has(word));
const hasRealName = (name: string | undefined, symbol: string): name is string => name !== undefined && name.trim() !== '' && name.trim().toUpperCase() !== symbol;

/** Same words, in any order (`Mastercard Incorporated` and `MASTERCARD INC`). */
function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((word) => b.includes(word));
}

/** A looser match for a US-registered company: the holding's name is the start of the SEC title (`UnitedHealth` and `UNITEDHEALTH GROUP INC`). */
function startsWithWords(name: readonly string[], title: readonly string[]): boolean {
  return name.length > 0 && name.length <= title.length && name.every((word, index) => word === title[index]);
}

function nameMatch(table: TickerTable, name: string, usIsin: boolean): string | undefined {
  const wanted = significantWords(name);
  const hits = new Set<string>();
  for (const entry of table.values()) {
    const title = significantWords(entry.title);
    if (sameWords(wanted, title) || (usIsin && startsWithWords(wanted, title))) hits.add(entry.cik);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

function viaAlias(table: TickerTable, base: string, name: string | undefined, symbol: string): string | undefined {
  const target = TICKER_ALIASES.get(base);
  const entry = target === undefined ? undefined : table.get(target);
  if (entry === undefined) return undefined;
  return hasRealName(name, symbol) && !sharesWord(entry.title, new Set(significantWords(name))) ? undefined : entry.cik;
}

/** The SEC registration of a holding, and how it was found; `undefined` when the symbol is no SEC registrant the table can tell. */
export function resolveTicker(table: TickerTable, query: TickerQuery): TickerMatch | undefined {
  const symbol = query.symbol.toUpperCase();
  const { name } = query;
  const usIsin = query.isin?.toUpperCase().startsWith('US') ?? false;
  const dotted = symbol.includes('.');
  const direct = table.get(symbol) ?? table.get(symbol.replaceAll('.', '-'));
  if (direct !== undefined && !dotted) return { cik: direct.cik, via: 'ticker' };
  const base = dotted ? symbol.slice(0, symbol.indexOf('.')) : symbol;
  if (dotted) {
    // A class share (`BRK.B`) is a dash in the SEC table; a suffixed listing matches its US ticker only when the names agree.
    if (direct !== undefined) return { cik: direct.cik, via: 'ticker' };
    const baseEntry = table.get(base);
    if (baseEntry !== undefined && hasRealName(name, symbol) && sharesWord(baseEntry.title, new Set(significantWords(name)))) return { cik: baseEntry.cik, via: 'ticker' };
    const alias = viaAlias(table, base, name, symbol);
    if (alias !== undefined) return { cik: alias, via: 'alias' };
  }
  const named = hasRealName(name, symbol) ? nameMatch(table, name, usIsin) : undefined;
  return named === undefined ? undefined : { cik: named, via: 'name' };
}

/** The CIK only (kept for callers that do not care how it was found). */
export const lookupTicker = (table: TickerTable, symbol: string, name: string | undefined): string | undefined => resolveTicker(table, { symbol, name })?.cik;
