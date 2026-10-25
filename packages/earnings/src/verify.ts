/**
 * The core safety rule: nothing the model said is shown unless it can be found in the release. Every number must be located in the text
 * (`NumberIndex.has`), a quote must appear verbatim (normalised whitespace and quotes), a bullet must share at least 60 % of its words with
 * one sentence of the release and every number in it must be printed there. What fails is dropped, never repaired, and counted.
 */
import { KPI_TEMPLATES, type KpiTemplateId, type MetricUnit } from '@portfolio/shared';
import { NumberIndex, nextNumber, normalizeForQuote, parseAmount, wordsOf, type ParsedAmount } from './numbers.js';
import type { ExtractedPair, Extraction } from './schema.js';

/** A figure that was found in the text. */
export interface VerifiedValue {
  value: number;
  raw: string;
  kind: ParsedAmount['kind'];
  /** The unit word the figure was scaled by (`1e6` for million), when it had one. */
  scale?: number;
}

export interface VerifiedPair {
  value: VerifiedValue;
  yearAgo?: VerifiedValue;
}

export interface VerifiedGuidance {
  label: string;
  period?: string;
  low?: VerifiedValue;
  high?: VerifiedValue;
  point?: VerifiedValue;
}

export interface VerifiedSegment {
  name: string;
  value: VerifiedValue;
  yearAgo?: VerifiedValue;
}

export interface Verified {
  period?: string;
  /** ISO code or symbol found in the text. */
  currency?: string;
  epsGaap?: VerifiedPair;
  epsAdjusted?: VerifiedPair;
  revenue?: VerifiedPair;
  operatingIncome?: VerifiedPair;
  operatingMargin?: VerifiedPair;
  netIncome?: VerifiedPair;
  operatingCashFlow?: VerifiedPair;
  capex?: VerifiedPair;
  freeCashFlow?: VerifiedPair;
  dilutedShares?: VerifiedPair;
  kpis: Record<string, VerifiedPair>;
  guidance: VerifiedGuidance[];
  segments: VerifiedSegment[];
  keyUpdates: string[];
  quote?: { text: string; speaker?: string };
}

export interface Verification {
  verified: Verified;
  /** Names of the fields that were dropped (never values), one entry per drop. */
  dropped: string[];
}

type PairKey = 'epsGaap' | 'epsAdjusted' | 'revenue' | 'operatingIncome' | 'operatingMargin' | 'netIncome' | 'operatingCashFlow' | 'capex' | 'freeCashFlow' | 'dilutedShares';

/** What a figure must look like: a per-share amount has no unit word, a percentage is a percentage, money is not a percentage. */
const PAIR_UNITS: Readonly<Record<PairKey, MetricUnit>> = {
  epsGaap: 'perShare',
  epsAdjusted: 'perShare',
  revenue: 'money',
  operatingIncome: 'money',
  operatingMargin: 'percent',
  netIncome: 'money',
  operatingCashFlow: 'money',
  capex: 'money',
  freeCashFlow: 'money',
  dilutedShares: 'count',
};

const PAIR_KEYS = Object.keys(PAIR_UNITS) as PairKey[];

const ISO_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'DKK', 'SEK', 'NOK', 'CNY', 'HKD', 'SGD', 'INR', 'KRW', 'BRL', 'MXN', 'ZAR', 'PLN', 'TWD']);
const SYMBOL_CURRENCY: ReadonlyMap<string, string> = new Map([
  ['$', 'USD'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
]);
const MIN_QUOTE_CHARS = 20;
const BULLET_OVERLAP = 0.6;
const MAX_BULLET_WORDS = 12;
const MIN_BULLET_WORDS = 3;
const MAX_KEY_UPDATES = 6;

/** Does the amount look like the unit the field expects? (A percentage is not revenue; EPS has no `million`.) */
function plausible(amount: ParsedAmount, unit: MetricUnit): boolean {
  if (unit === 'percent') return amount.kind !== 'money';
  if (amount.kind === 'percent') return false;
  if (unit === 'perShare') return amount.scale === undefined;
  return true;
}

function checked(raw: string, unit: MetricUnit, index: NumberIndex): VerifiedValue | undefined {
  const amount = parseAmount(raw);
  if (amount === undefined || !plausible(amount, unit) || !index.has(amount)) return undefined;
  return { value: amount.value, raw: raw.trim(), kind: amount.kind, ...(amount.scale === undefined ? {} : { scale: amount.scale }) };
}

/** The currency the release is written in: an ISO code the model named that the text contains, else the most frequent currency symbol. */
function currencyOf(claimed: string | undefined, text: string): string | undefined {
  const code = claimed?.trim().toUpperCase();
  if (code !== undefined && ISO_CURRENCIES.has(code) && text.toUpperCase().includes(code)) return code;
  const symbol = claimed === undefined ? undefined : SYMBOL_CURRENCY.get(claimed.trim());
  if (symbol !== undefined && text.includes(claimed!.trim())) return symbol;
  let best: { code: string; count: number } | undefined;
  for (const [mark, iso] of SYMBOL_CURRENCY) {
    const count = text.split(mark).length - 1;
    if (count > 0 && (best === undefined || count > best.count)) best = { code: iso, count };
  }
  return best?.code;
}

const sentencesOf = (text: string): string[][] =>
  text
    .split(/\n|;|\.\s|\s\|\s/)
    .map((sentence) => wordsOf(sentence))
    .filter((words) => words.length >= MIN_BULLET_WORDS);

/** Words of `claim` that appear in `candidate`, as a share of the claim's words. */
function overlap(claim: readonly string[], candidate: ReadonlySet<string>): number {
  return claim.length === 0 ? 0 : claim.filter((word) => candidate.has(word)).length / claim.length;
}

const hasNumbersOutsideText = (bullet: string, index: NumberIndex): boolean => {
  for (let token = nextNumber(bullet); token !== undefined; token = nextNumber(bullet, token.end)) if (!index.hasValue(token.value)) return true;
  return false;
};

const LOOSE_UNITS: readonly MetricUnit[] = ['money', 'perShare', 'percent'];

/** Checks the text of a guidance figure, which may be money, a per-share amount or a percentage. */
function checkedLoose(raw: string | undefined, index: NumberIndex): VerifiedValue | undefined {
  if (raw === undefined) return undefined;
  for (const unit of LOOSE_UNITS) {
    const found = checked(raw, unit, index);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Everything the checks of one release share: the number index, the words and sentences, and the list of drops. */
class Verifier {
  readonly dropped: string[] = [];
  readonly index: NumberIndex;
  readonly normalizedText: string;
  readonly textWords: ReadonlySet<string>;
  readonly sentences: ReadonlySet<string>[];

  constructor(readonly text: string) {
    this.index = new NumberIndex(text);
    this.normalizedText = normalizeForQuote(text);
    this.textWords = new Set(wordsOf(text));
    this.sentences = sentencesOf(text).map((words) => new Set(words));
  }

  drop(field: string): void {
    this.dropped.push(field);
  }

  pair(name: string, pair: ExtractedPair | undefined, unit: MetricUnit): VerifiedPair | undefined {
    if (pair === undefined) return undefined;
    const value = checked(pair.value, unit, this.index);
    if (value === undefined) {
      this.drop(`${name}.value`);
      return undefined;
    }
    if (pair.yearAgo === undefined) return { value };
    const yearAgo = checked(pair.yearAgo, unit, this.index);
    if (yearAgo === undefined) this.drop(`${name}.yearAgo`);
    return { value, ...(yearAgo === undefined ? {} : { yearAgo }) };
  }

  /** A text a claim shares at least 60 % of its words with, in one sentence of the release. */
  supports(words: readonly string[]): boolean {
    return this.sentences.some((sentence) => overlap(words, sentence) >= BULLET_OVERLAP);
  }

  period(claimed: string | undefined): string | undefined {
    if (claimed === undefined) return undefined;
    const year = /\b20\d{2}\b/.exec(claimed)?.[0];
    // Labels like `3Q26` or `Q3 FY26` have no four-digit year: they count when the release prints the label itself.
    const printed = /\d/.test(claimed) && this.normalizedText.includes(normalizeForQuote(claimed));
    if ((year !== undefined && this.text.includes(year)) || (year === undefined && printed)) return claimed;
    this.drop('period');
    return undefined;
  }

  kpis(entries: Extraction['kpis'], template: KpiTemplateId): Record<string, VerifiedPair> {
    const slots = new Map(KPI_TEMPLATES[template].slots.map((slot) => [slot.key, slot.unit]));
    const out: Record<string, VerifiedPair> = {};
    for (const entry of entries ?? []) {
      const unit = slots.get(entry.key);
      if (unit === undefined) {
        this.drop(`kpis.${entry.key}`);
        continue;
      }
      const pair = this.pair(`kpis.${entry.key}`, entry, unit);
      if (pair !== undefined && out[entry.key] === undefined) out[entry.key] = pair;
    }
    return out;
  }

  guidance(entries: Extraction['guidance']): VerifiedGuidance[] {
    const out: VerifiedGuidance[] = [];
    for (const entry of entries ?? []) {
      const low = checkedLoose(entry.low, this.index);
      const high = checkedLoose(entry.high, this.index);
      const point = checkedLoose(entry.point, this.index);
      if (!this.supports(wordsOf(entry.label)) || (low === undefined && high === undefined && point === undefined)) {
        this.drop('guidance');
        continue;
      }
      out.push({ label: entry.label, ...(entry.period === undefined ? {} : { period: entry.period }), ...(low ? { low } : {}), ...(high ? { high } : {}), ...(point ? { point } : {}) });
    }
    return out;
  }

  segments(entries: Extraction['segments']): VerifiedSegment[] {
    const out: VerifiedSegment[] = [];
    for (const segment of entries ?? []) {
      const nameWords = wordsOf(segment.name);
      const value = checked(segment.value, 'money', this.index);
      if (value === undefined || nameWords.length === 0 || !nameWords.every((word) => this.textWords.has(word))) {
        this.drop('segments');
        continue;
      }
      const yearAgo = segment.yearAgo === undefined ? undefined : checked(segment.yearAgo, 'money', this.index);
      if (segment.yearAgo !== undefined && yearAgo === undefined) this.drop('segments.yearAgo');
      out.push({ name: segment.name, value, ...(yearAgo ? { yearAgo } : {}) });
    }
    return out;
  }

  keyUpdates(bullets: Extraction['keyUpdates']): string[] {
    const out: string[] = [];
    for (const bullet of bullets ?? []) {
      const words = wordsOf(bullet);
      const fits = words.length >= MIN_BULLET_WORDS && words.length <= MAX_BULLET_WORDS && out.length < MAX_KEY_UPDATES;
      if (fits && !hasNumbersOutsideText(bullet, this.index) && this.supports(words)) out.push(bullet);
      else this.drop('keyUpdates');
    }
    return out;
  }

  quote(claimed: Extraction['quote']): Verified['quote'] {
    if (claimed === undefined) return undefined;
    const normalized = normalizeForQuote(claimed.text);
    if (normalized.length < MIN_QUOTE_CHARS || !this.normalizedText.includes(normalized)) {
      this.drop('quote');
      return undefined;
    }
    return { text: claimed.text, ...(claimed.speaker === undefined ? {} : { speaker: claimed.speaker }) };
  }
}

/** Verifies the model's extraction against the release text. Pure: the same inputs always give the same output. */
export function verifyExtraction(extraction: Extraction, text: string, template: KpiTemplateId): Verification {
  const verifier = new Verifier(text);
  const verified: Verified = { kpis: {}, guidance: [], segments: [], keyUpdates: [] };
  for (const key of PAIR_KEYS) {
    const pair = verifier.pair(key, extraction[key], PAIR_UNITS[key]);
    if (pair !== undefined) verified[key] = pair;
  }
  const currency = currencyOf(extraction.currency, text);
  const period = verifier.period(extraction.period);
  const quote = verifier.quote(extraction.quote);
  return {
    verified: {
      ...verified,
      ...(currency === undefined ? {} : { currency }),
      ...(period === undefined ? {} : { period }),
      ...(quote === undefined ? {} : { quote }),
      kpis: verifier.kpis(extraction.kpis, template),
      guidance: verifier.guidance(extraction.guidance),
      segments: verifier.segments(extraction.segments),
      keyUpdates: verifier.keyUpdates(extraction.keyUpdates),
    },
    dropped: verifier.dropped,
  };
}

/** Whether anything that makes a summary worth showing was verified: revenue, a per-share result or a template headline figure. */
export function hasHeadline(verified: Verified): boolean {
  return [verified.revenue, verified.epsAdjusted, verified.epsGaap, verified.kpis.affoPerShare, verified.kpis.ffoPerShare, verified.netIncome].some((pair) => pair !== undefined);
}
