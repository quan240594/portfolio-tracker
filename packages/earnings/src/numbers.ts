/**
 * Reading figures the way a press release prints them, and finding them again in the release text.
 *
 * `parseAmount` turns a printed figure (`$20.71 billion`, `(1.2)`, `11.8%`, `€1,234.5m`) into a number; `NumberIndex` lists every
 * number of a release with its unit word and sign context. A figure the model extracted counts as verified only when `NumberIndex.has`
 * finds it in the text: the same value, in the same or a stated scale (a table "in millions" holds `20,710` for `$20.71 billion`).
 */

export type AmountKind = 'money' | 'percent' | 'plain';

export interface ParsedAmount {
  /** Whole units for money and plain numbers, percent points for percentages (negative for losses). */
  value: number;
  kind: AmountKind;
  /** The unit word that scaled it (`million`), when there was one. */
  scale?: number;
  negative: boolean;
}

const SCALES: ReadonlyMap<string, number> = new Map([
  ['thousand', 1e3],
  ['k', 1e3],
  ['million', 1e6],
  ['mm', 1e6],
  ['m', 1e6],
  ['billion', 1e9],
  ['bn', 1e9],
  ['b', 1e9],
  ['trillion', 1e12],
  ['tn', 1e12],
]);

const MINUS_SIGNS = '-−–';
const CURRENCY_MARKS = '$€£¥';

const LONG_WORD = /[a-zA-Z]{4,}/;
const ALLOWED_WORDS = /\b(?:usd|eur|gbp|chf|jpy|cad|aud|per share|diluted|x)\b/gi;
const CURRENCY_CODE = /\b(?:usd|eur|gbp|chf|jpy|cad|aud)\b/i;

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= '0' && char <= '9';

/** Three digits and no fourth: the group after a thousands comma. */
const isThousandsGroup = (text: string, from: number): boolean => isDigit(text[from]) && isDigit(text[from + 1]) && isDigit(text[from + 2]) && !isDigit(text[from + 3]);

export interface NumberToken {
  /** The digits as printed, with thousands separators removed. */
  digits: string;
  value: number;
  /** Index of the first digit and just after the last character of the number. */
  start: number;
  end: number;
}

/** The first number in `text` from `from`: digits with thousands commas and one decimal point (`1,234.50`). */
export function nextNumber(text: string, from = 0): NumberToken | undefined {
  let start = from;
  while (start < text.length && !isDigit(text[start])) start += 1;
  if (start >= text.length) return undefined;
  let end = start;
  let digits = '';
  let seenDot = false;
  while (end < text.length) {
    const char = text[end];
    if (isDigit(char)) digits += char;
    else if (char === ',' && isDigit(text[end - 1]) && isThousandsGroup(text, end + 1)) {
      // a thousands separator: skipped
    } else if (char === '.' && !seenDot && isDigit(text[end + 1]) && isDigit(text[end - 1])) {
      seenDot = true;
      digits += '.';
    } else break;
    end += 1;
  }
  return { digits, value: Number(digits), start, end };
}

/** The scale word or `%` right after a number (`million`, `bn`, `%`, `percent`), with the index after it. */
function suffixAfter(text: string, from: number): { scale?: number; percent: boolean; end: number } {
  let index = from;
  while (text[index] === ' ') index += 1;
  if (text[index] === '%') return { percent: true, end: index + 1 };
  let word = '';
  while (index + word.length < text.length && /[a-zA-Z]/.test(text[index + word.length]!)) word += text[index + word.length];
  const lower = word.toLowerCase();
  if (lower === 'percent' || lower === 'pct') return { percent: true, end: index + word.length };
  const scale = SCALES.get(lower);
  return scale === undefined ? { percent: false, end: from } : { scale, percent: false, end: index + word.length };
}

const hasCurrency = (text: string): boolean => [...CURRENCY_MARKS].some((mark) => text.includes(mark)) || CURRENCY_CODE.test(text);

function kindOf(text: string, percent: boolean): AmountKind {
  if (percent) return 'percent';
  return hasCurrency(text) ? 'money' : 'plain';
}

/** True for a figure written as a loss: in parentheses or with a leading minus sign. */
function isNegativeAt(text: string, tokenStart: number): boolean {
  let before = tokenStart - 1;
  while (before >= 0 && (text[before] === ' ' || CURRENCY_MARKS.includes(text[before]!))) before -= 1;
  const mark = text[before];
  return mark === '(' || (mark !== undefined && MINUS_SIGNS.includes(mark));
}

/**
 * A figure as printed by a company. Returns `undefined` for anything that is not exactly one number with an optional currency mark,
 * unit word or percent sign (a sentence, a range, two numbers): such a value cannot be checked and is not used.
 */
export function parseAmount(raw: string): ParsedAmount | undefined {
  const text = raw.trim();
  const token = nextNumber(text);
  if (token === undefined || !Number.isFinite(token.value)) return undefined;
  const suffix = suffixAfter(text, token.end);
  const rest = text.slice(suffix.end);
  const leading = text.slice(0, token.start);
  if (/\d/.test(rest) || LONG_WORD.test(leading) || LONG_WORD.test(rest.replaceAll(ALLOWED_WORDS, ''))) return undefined;
  const negative = isNegativeAt(text, token.start);
  const scale = suffix.scale;
  const magnitude = token.value * (scale ?? 1);
  return { value: negative ? -magnitude : magnitude, kind: kindOf(text, suffix.percent), ...(scale === undefined ? {} : { scale }), negative };
}

const TABLE_SCALE = /(?:\bin|\()\s*(?:\$|[A-Za-z]{3}\s)?\s*(thousands|millions|billions)\b|\(\s*\$?\s*(000s|000's)\s*\)/gi;
const NEGATIVE_WORDS = /\b(?:loss|losses|decrease|decreased|decline|declined|deficit|negative|outflow|used in|down)\b/i;
const CONTEXT_CHARS = 80;

/** Millions as `1e6`, thousands as `1e3`: the scales a release says its tables use. */
function tableScales(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(TABLE_SCALE)) {
    const word = (match[1] ?? match[2] ?? '').toLowerCase();
    if (word === 'millions') found.add(1e6);
    else if (word === 'billions') found.add(1e9);
    else found.add(1e3);
  }
  return [...found];
}

interface IndexedNumber {
  value: number;
  scale?: number;
  percent: boolean;
  negative: boolean;
  negativeContext: boolean;
}

const sameValue = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/** Every number of a release text, for checking extracted figures against it. */
export class NumberIndex {
  readonly #numbers: IndexedNumber[] = [];
  readonly #scales: number[];

  constructor(text: string) {
    this.#scales = tableScales(text);
    let from = 0;
    for (let token = nextNumber(text, from); token !== undefined; token = nextNumber(text, from)) {
      from = token.end;
      const suffix = suffixAfter(text, token.end);
      const before = text.slice(Math.max(0, token.start - CONTEXT_CHARS), token.start);
      this.#numbers.push({ value: token.value, scale: suffix.scale, percent: suffix.percent, negative: isNegativeAt(text, token.start), negativeContext: NEGATIVE_WORDS.test(before) });
    }
  }

  /** The number of distinct numeric tokens found (for tests and the prompt-size estimate). */
  get size(): number {
    return this.#numbers.length;
  }

  /** Whether the text prints the plain number `value` (a count of shares, a growth percentage) in any form: used for the figures inside bullets. */
  hasValue(value: number): boolean {
    return this.#numbers.some((entry) => sameValue(entry.value, Math.abs(value)) || sameValue(entry.value * (entry.scale ?? 1), Math.abs(value)));
  }

  /** Whether the release prints `amount`: the same magnitude, in the stated scale or a scale its tables declare, and a loss only where it reads as one. */
  has(amount: ParsedAmount): boolean {
    const target = Math.abs(amount.value);
    return this.#numbers.some((entry) => {
      if (amount.negative && !entry.negative && !entry.negativeContext) return false;
      if (amount.kind === 'percent') return sameValue(entry.value, target);
      if (entry.scale !== undefined) return sameValue(entry.value * entry.scale, target);
      return sameValue(entry.value, target) || this.#scales.some((scale) => sameValue(entry.value * scale, target));
    });
  }
}

/** Words of a text for the loose matching of bullets and names: lower case letters and digits, at least two characters. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll(/[’‘`]/g, "'")
    .split(/[^a-z0-9%$.'-]+/)
    .map((word) => word.replaceAll(/^[.'-]+|[.'-]+$/g, ''))
    .filter((word) => word.length >= 2);
}

/** A text normalised for verbatim comparison of quotes: straight quotes and dashes, one space, lower case. */
export function normalizeForQuote(text: string): string {
  return text
    .replaceAll(/[“”„‟«»]/g, '"')
    .replaceAll(/[‘’‚‛`´]/g, "'")
    .replaceAll(/[–—−]/g, '-')
    .replaceAll(/[\s\u00a0]+/g, ' ')
    .trim()
    .toLowerCase();
}
