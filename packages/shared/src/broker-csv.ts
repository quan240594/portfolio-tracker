/**
 * Trading 212 "History" CSV export -> this app's import CSV (`date,type,symbol,quantity,price,fee,currency,note,fxRate`).
 *
 * Pure and deterministic. Only filled buys/sells and dividends become rows; deposits, withdrawals, interest,
 * conversions, ... are counted in `ignored`. Instruments whose listing cannot be established are skipped and
 * reported in `unmapped` (never guessed). Amounts follow the conventions of the app: prices/fees in the instrument's
 * major currency, `fxRate` = units of instrument currency per 1 EUR, only for EUR accounts and only when it agrees
 * with the amounts of the row (see resolveFxRate).
 */
import { roundTo } from './analytics.js';
import { normalizeCurrency, resolveFxRate, sumFees, type FeePart } from './broker-fx.js';
import { mapT212Symbol } from './broker-symbols.js';
import type { UnmappedInstrument } from './broker.js';

const OUTPUT_HEADER = ['date', 'type', 'symbol', 'quantity', 'price', 'fee', 'currency', 'note', 'fxRate'] as const;
const BASE_CURRENCY = 'EUR';
/** Fee columns of the export; each has a sibling `Currency (<name>)` column. Older exports use some of the other names. */
const FEE_COLUMNS = [
  'Stamp duty reserve tax',
  'Stamp duty',
  'Currency conversion fee',
  'Finra fee',
  'Transaction fee',
  'French transaction tax',
  'Charge amount',
  'Commission',
] as const;

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF, blank lines skipped. */
export function parseCsvText(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** True when the header row looks like a Trading 212 history export. */
export function isTrading212Header(header: readonly string[]): boolean {
  const names = new Set(header.map((h) => h.trim().toLowerCase()));
  return ['action', 'isin', 'ticker', 'no. of shares'].every((n) => names.has(n)) && (names.has('time') || names.has('time (utc)'));
}

export interface T212CsvConversion {
  /** Import CSV in the app's format; header only when nothing could be converted. */
  csv: string;
  /** Rows written to `csv`. */
  imported: number;
  /** Actions that are not transactions (Deposit, Withdrawal, Interest on cash, ...), with row counts. */
  ignored: { action: string; count: number }[];
  unmapped: UnmappedInstrument[];
  invalid: { row: number; message: string }[];
  warnings: string[];
}

interface OutRow {
  time: string;
  date: string;
  type: 'BUY' | 'SELL' | 'DIVIDEND';
  symbol: string;
  quantity: number;
  price: number;
  fee: number;
  currency: string;
  note: string;
  fxRate?: number;
}

const ACTION_TRADE = /^(?:market|limit|stop|stop limit)\s+(buy|sell)$/i;
export function classifyAction(action: string): 'BUY' | 'SELL' | 'DIVIDEND' | undefined {
  const a = action.trim();
  const trade = ACTION_TRADE.exec(a);
  if (trade) return trade[1]!.toUpperCase() as 'BUY' | 'SELL';
  return /^dividend/i.test(a) ? 'DIVIDEND' : undefined;
}

const toNumber = (s: string | undefined): number | undefined => {
  const t = s?.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

class RowReader {
  private readonly index = new Map<string, number>();
  constructor(header: readonly string[]) {
    header.forEach((h, i) => {
      const key = h.trim().toLowerCase();
      if (!this.index.has(key)) this.index.set(key, i);
    });
  }
  text(row: readonly string[], name: string): string {
    const i = this.index.get(name.toLowerCase());
    return i === undefined ? '' : (row[i] ?? '').trim();
  }
  num(row: readonly string[], name: string): number | undefined {
    return toNumber(this.text(row, name));
  }
}

function feeParts(reader: RowReader, row: readonly string[], accountCurrency: string, wht: boolean): FeePart[] {
  const names = wht ? ['Withholding tax'] : FEE_COLUMNS;
  const parts: FeePart[] = [];
  for (const name of names) {
    const amount = reader.num(row, name);
    if (!amount) continue;
    parts.push({ amount, currency: reader.text(row, `Currency (${name})`) || accountCurrency });
  }
  return parts;
}

const quoteField = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

function toCsv(rows: readonly OutRow[]): string {
  const lines = rows.map((r) =>
    [r.date, r.type, r.symbol, r.quantity, r.price, r.fee, r.currency, quoteField(r.note), r.fxRate ?? '']
      .map(String)
      .join(','),
  );
  return [OUTPUT_HEADER.join(','), ...lines].join('\n') + '\n';
}

const bump = <K>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1);

type RowOutcome =
  | { kind: 'row'; row: OutRow; unconverted: number }
  | { kind: 'ignored'; action: string }
  | { kind: 'invalid' }
  | { kind: 'unmapped'; item: UnmappedInstrument };

interface Amounts {
  fee: number;
  unconverted: number;
  rate: number | undefined;
}

/** Fee (instrument currency) and the account->instrument rate of one row. */
function amountsFor(
  reader: RowReader,
  record: readonly string[],
  type: OutRow['type'],
  instrumentCurrency: string,
  accountCurrency: string,
  quantity: number,
  price: number,
): Amounts {
  const total = Math.abs(reader.num(record, 'Total') ?? 0);
  const reported = reader.num(record, 'Exchange rate');
  const parts = feeParts(reader, record, accountCurrency, type === 'DIVIDEND');
  if (instrumentCurrency === accountCurrency) return { ...sumFees(parts, instrumentCurrency, accountCurrency, undefined), rate: undefined };
  if (type !== 'DIVIDEND') {
    const rate = resolveFxRate({ reported, accountAmount: total, localAmount: quantity * price });
    return { ...sumFees(parts, instrumentCurrency, accountCurrency, rate), rate };
  }
  // Dividend: the net amount in the account currency is exact, so the rate that reproduces it is the best estimate.
  const fees = sumFees(parts, instrumentCurrency, accountCurrency, undefined);
  const net = quantity * price - fees.fee;
  const rate = resolveFxRate({ reported, accountAmount: total, localAmount: net }) ?? (total > 0 && net > 0 ? roundTo(net / total, 6) : undefined);
  return { ...fees, rate };
}

function unmappedItem(reader: RowReader, record: readonly string[], reason: string): UnmappedInstrument {
  const isin = reader.text(record, 'ISIN');
  const name = reader.text(record, 'Name');
  return {
    ticker: reader.text(record, 'Ticker'),
    ...(isin ? { isin } : {}),
    ...(name ? { name } : {}),
    currency: reader.text(record, 'Currency (Price / share)').toUpperCase(),
    reason,
    count: 1,
  };
}

function convertRow(reader: RowReader, record: readonly string[], overrides: Readonly<Record<string, string>>): RowOutcome {
  const action = reader.text(record, 'Action');
  const type = classifyAction(action);
  if (!type) return { kind: 'ignored', action: action || '(blank)' };
  // Current exports call the column `Time (UTC)`, older ones `Time`.
  const time = reader.text(record, 'Time') || reader.text(record, 'Time (UTC)');
  const date = /^\d{4}-\d{2}-\d{2}/.exec(time)?.[0];
  const ticker = reader.text(record, 'Ticker');
  const priceCurrency = reader.text(record, 'Currency (Price / share)');
  const quantity = reader.num(record, 'No. of shares');
  const rawPrice = reader.num(record, 'Price / share');
  if (!date || !ticker || !priceCurrency || !quantity || quantity <= 0 || rawPrice === undefined || rawPrice < 0) return { kind: 'invalid' };

  const isin = reader.text(record, 'ISIN') || undefined;
  const mapping = mapT212Symbol({ ticker, isin, currency: priceCurrency }, overrides);
  if (!mapping.ok) return { kind: 'unmapped', item: unmappedItem(reader, record, mapping.reason) };

  const instrument = normalizeCurrency(priceCurrency);
  const price = roundTo(rawPrice / instrument.divisor, 8);
  const accountCurrency = reader.text(record, 'Currency (Total)').toUpperCase();
  const { fee, unconverted, rate } = amountsFor(reader, record, type, instrument.currency, accountCurrency, quantity, price);
  const row: OutRow = {
    time,
    date,
    type,
    symbol: mapping.symbol,
    quantity: roundTo(quantity, 8),
    price,
    fee,
    currency: instrument.currency,
    note: `T212 ${ticker}`,
  };
  if (rate !== undefined && accountCurrency === BASE_CURRENCY) row.fxRate = rate;
  return { kind: 'row', row, unconverted };
}

export function convertTrading212Csv(content: string, overrides: Readonly<Record<string, string>> = {}): T212CsvConversion {
  const [header = [], ...records] = parseCsvText(content);
  const reader = new RowReader(header);
  const rows: { row: OutRow; seq: number }[] = [];
  const ignored = new Map<string, number>();
  const unmapped = new Map<string, UnmappedInstrument>();
  const invalid: { row: number; message: string }[] = [];
  let unconverted = 0;

  records.forEach((record, seq) => {
    const outcome = convertRow(reader, record, overrides);
    if (outcome.kind === 'row') {
      rows.push({ row: outcome.row, seq });
      unconverted += outcome.unconverted;
    } else if (outcome.kind === 'ignored') bump(ignored, outcome.action);
    else if (outcome.kind === 'invalid') invalid.push({ row: seq + 1, message: 'Missing or invalid time, ticker, shares, price or currency' });
    else {
      const key = `${outcome.item.ticker}|${outcome.item.reason}`;
      const known = unmapped.get(key);
      if (known) known.count++;
      else unmapped.set(key, outcome.item);
    }
  });

  rows.sort((a, b) => a.row.time.localeCompare(b.row.time) || a.seq - b.seq);
  const warnings = unconverted > 0 ? [`${unconverted} fee amount(s) in another currency could not be converted and were left out`] : [];
  return {
    csv: toCsv(rows.map((r) => r.row)),
    imported: rows.length,
    ignored: [...ignored].map(([action, count]) => ({ action, count })).sort((a, b) => a.action.localeCompare(b.action)),
    unmapped: [...unmapped.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)),
    invalid,
    warnings,
  };
}
