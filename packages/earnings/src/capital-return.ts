/**
 * Dividend and share repurchase verification: the same rule as the rest of the summary, nothing is shown unless the release prints it.
 * An amount must be found in the text (`NumberIndex`), a date must parse and be printed as the model wrote it, and a word such as "raised"
 * or "new" counts only when a sentence about the dividend (or the repurchase) says it. What fails is dropped and counted. The status says
 * what is left: `announced`, `none`, or `not-found` (the release mentions an amount, nothing could be verified).
 */
import type { BuybackAction, CapitalReturnStatus, DividendAction, DividendFrequency } from '@portfolio/shared';
import { NumberIndex, normalizeForQuote, parseAmount, type ParsedAmount } from './numbers.js';
import { parsePrintedDate, withinDays } from './printed-date.js';
import type { Extraction } from './schema.js';
import { dropUndefined } from './util.js';
import type { VerifiedValue } from './verify.js';

export interface VerifiedDividend {
  status: CapitalReturnStatus;
  perShare?: VerifiedValue;
  previousPerShare?: VerifiedValue;
  /** What the release says (`raised`, `cut`, ...), kept only when a sentence about the dividend says it. */
  action?: DividendAction;
  frequency?: DividendFrequency;
  exDate?: string;
  recordDate?: string;
  payDate?: string;
}

export interface VerifiedBuyback {
  status: CapitalReturnStatus;
  action?: BuybackAction;
  authorization?: VerifiedValue;
  repurchased?: VerifiedValue;
  repurchasedShares?: VerifiedValue;
  remaining?: VerifiedValue;
}

export interface VerifiedCapitalReturn {
  dividend: VerifiedDividend;
  buyback: VerifiedBuyback;
  /** Names of the fields dropped. */
  dropped: string[];
}

type ClaimedDividend = NonNullable<Extraction['dividend']>;
type ClaimedBuyback = NonNullable<Extraction['buyback']>;

/** A date that is further than this from the release date is not the dividend of this release. */
const DATE_WINDOW_DAYS = 400;
const MAX_PER_SHARE = 1000;

/** The words of the model mapped to what they mean; anything else is not a dividend action. */
const DIVIDEND_WORDS: ReadonlyMap<string, DividendAction> = new Map([
  ['raised', 'raised'],
  ['raise', 'raised'],
  ['increased', 'raised'],
  ['increase', 'raised'],
  ['higher', 'raised'],
  ['cut', 'cut'],
  ['reduced', 'cut'],
  ['reduce', 'cut'],
  ['decreased', 'cut'],
  ['lowered', 'cut'],
  ['maintained', 'maintained'],
  ['maintain', 'maintained'],
  ['unchanged', 'maintained'],
  ['initiated', 'initiated'],
  ['initiate', 'initiated'],
  ['new', 'initiated'],
  ['suspended', 'suspended'],
  ['suspend', 'suspended'],
  ['eliminated', 'suspended'],
  ['discontinued', 'suspended'],
]);

/** The stems a sentence about the dividend must contain for the action to count (the release says it, not only the model). */
const DIVIDEND_STEMS: Readonly<Record<DividendAction, readonly string[]>> = {
  raised: ['increas', 'raise', 'raising', 'higher', 'boost', 'hike'],
  cut: ['reduc', 'cut', 'decreas', 'lower', 'lowering'],
  maintained: ['maintain', 'unchanged', 'consistent with', 'same as', 'flat'],
  initiated: ['initiat', 'first-ever', 'first ever', 'first quarterly', 'first dividend', 'inaugural', 'new quarterly dividend', 'new dividend'],
  suspended: ['suspend', 'eliminat', 'discontinu', 'no longer pay', 'will not pay'],
};

const FREQUENCY_WORDS: ReadonlyMap<string, DividendFrequency> = new Map([
  ['monthly', 'monthly'],
  ['quarterly', 'quarterly'],
  ['semi-annual', 'semi-annual'],
  ['semiannual', 'semi-annual'],
  ['semi annual', 'semi-annual'],
  ['half-yearly', 'semi-annual'],
  ['annual', 'annual'],
  ['yearly', 'annual'],
  ['special', 'special'],
  ['one-time', 'special'],
]);

const FREQUENCY_STEMS: Readonly<Record<DividendFrequency, readonly string[]>> = {
  monthly: ['monthly', 'per month'],
  quarterly: ['quarterly', 'per quarter'],
  'semi-annual': ['semi-annual', 'semiannual', 'semi annual', 'half-yearly', 'twice a year'],
  annual: ['annual', 'yearly', 'per year'],
  special: ['special', 'one-time', 'one time'],
};

const BUYBACK_WORDS: ReadonlyMap<string, BuybackAction> = new Map([
  ['new', 'new'],
  ['newly authorized', 'new'],
  ['authorized', 'new'],
  ['announced', 'new'],
  ['increased', 'increased'],
  ['increase', 'increased'],
  ['upsized', 'increased'],
  ['expanded', 'increased'],
  ['additional', 'increased'],
  ['ongoing', 'ongoing'],
]);

const BUYBACK_STEMS: Readonly<Record<Exclude<BuybackAction, 'ongoing'>, readonly string[]>> = {
  new: ['new ', 'newly', 'inaugural', 'authorized a', 'authorized an', 'approved a', 'approved an', 'announced a', 'announced an', 'established a', 'establishes a'],
  increased: ['increas', 'upsiz', 'expand', 'additional', 'raised'],
};

const KEYWORDS_DIVIDEND = ['dividend'];
const KEYWORDS_BUYBACK = ['repurchas', 'buyback', 'buy-back', 'buy back'];

const CURRENCY_MARKS = '$€£¥';

const squash = (text: string): string => normalizeForQuote(text).replaceAll(/[.,]/g, '');

/** The sentences (lines and `. `-separated parts, lower case) that contain one of the keywords. */
function sentencesWith(text: string, keywords: readonly string[]): string[] {
  return text
    .toLowerCase()
    .split(/\n|\.\s/)
    .filter((sentence) => keywords.some((keyword) => sentence.includes(keyword)));
}

/** A currency mark directly followed by a digit (optionally one space): an amount, not just a word. */
function hasCurrencyAmount(sentence: string): boolean {
  for (let index = 0; index < sentence.length; index += 1) {
    if (!CURRENCY_MARKS.includes(sentence[index]!)) continue;
    const next = sentence[index + 1] === ' ' ? sentence[index + 2] : sentence[index + 1];
    if (next !== undefined && next >= '0' && next <= '9') return true;
  }
  return false;
}

/** A dividend sentence that declares or pays an amount: the release mentions a dividend even if nothing could be read from it. */
export function dividendMentioned(text: string): boolean {
  return sentencesWith(text, KEYWORDS_DIVIDEND).some((sentence) => hasCurrencyAmount(sentence) && (sentence.includes('per share') || sentence.includes('declare') || sentence.includes('payable')));
}

/** A repurchase sentence with an amount. */
export function buybackMentioned(text: string): boolean {
  return sentencesWith(text, KEYWORDS_BUYBACK).some((sentence) => hasCurrencyAmount(sentence));
}

/** A figure the release prints, as a verified value; `undefined` when it does not read as a single amount or is not in the text. */
function checkedAmount(raw: string | undefined, index: NumberIndex, accept: (amount: ParsedAmount) => boolean): VerifiedValue | undefined {
  if (raw === undefined) return undefined;
  const amount = parseAmount(raw);
  if (amount === undefined || !accept(amount) || !index.has(amount)) return undefined;
  return { value: amount.value, raw: raw.trim(), kind: amount.kind, ...(amount.scale === undefined ? {} : { scale: amount.scale }) };
}

const perShareAmount = (amount: ParsedAmount): boolean => amount.kind !== 'percent' && amount.scale === undefined && amount.value > 0 && amount.value < MAX_PER_SHARE;
const moneyAmount = (amount: ParsedAmount): boolean => amount.kind !== 'percent' && amount.value > 0;
const shareCount = (amount: ParsedAmount): boolean => amount.kind === 'plain' && amount.value > 0;

/** `1.8 million shares` as `1.8 million`: the model is told to leave the word out and sometimes does not. */
function withoutShareWord(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const words = raw.split(' ').filter((word) => word !== '');
  if (['share', 'shares'].includes(words.at(-1)?.toLowerCase() ?? '')) words.pop();
  if (words.at(-1)?.toLowerCase() === 'common') words.pop();
  return words.join(' ');
}

class CapitalReturnVerifier {
  readonly dropped: string[] = [];
  readonly index: NumberIndex;
  readonly dividendSentences: string[];
  readonly buybackSentences: string[];
  readonly squashed: string;

  constructor(
    readonly text: string,
    readonly reportDate: string,
    index?: NumberIndex,
  ) {
    this.index = index ?? new NumberIndex(text);
    this.dividendSentences = sentencesWith(text, KEYWORDS_DIVIDEND);
    this.buybackSentences = sentencesWith(text, KEYWORDS_BUYBACK);
    this.squashed = squash(text);
  }

  /** A printed date as an ISO date, when it is printed so in the release, parses and is near the release date. */
  date(name: string, raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const iso = parsePrintedDate(raw, this.reportDate);
    if (iso !== undefined && this.squashed.includes(squash(raw)) && withinDays(iso, this.reportDate, DATE_WINDOW_DAYS)) return iso;
    this.dropped.push(`dividend.${name}`);
    return undefined;
  }

  amount(name: string, raw: string | undefined, accept: (amount: ParsedAmount) => boolean): VerifiedValue | undefined {
    const value = checkedAmount(raw, this.index, accept);
    if (value === undefined && raw !== undefined) this.dropped.push(name);
    return value;
  }

  dividendAction(claimed: string | undefined): DividendAction | undefined {
    if (claimed === undefined) return undefined;
    const action = DIVIDEND_WORDS.get(claimed.trim().toLowerCase());
    const found = action !== undefined && this.dividendSentences.some((sentence) => DIVIDEND_STEMS[action].some((stem) => sentence.includes(stem)));
    if (found) return action;
    this.dropped.push('dividend.action');
    return undefined;
  }

  frequency(claimed: string | undefined): DividendFrequency | undefined {
    if (claimed === undefined) return undefined;
    const frequency = FREQUENCY_WORDS.get(claimed.trim().toLowerCase());
    const found = frequency !== undefined && this.dividendSentences.some((sentence) => FREQUENCY_STEMS[frequency].some((stem) => sentence.includes(stem)));
    if (found) return frequency;
    this.dropped.push('dividend.frequency');
    return undefined;
  }

  buybackAction(claimed: string | undefined): BuybackAction | undefined {
    if (claimed === undefined) return undefined;
    const action = BUYBACK_WORDS.get(claimed.trim().toLowerCase());
    if (action === 'ongoing') return action;
    const found = action !== undefined && this.buybackSentences.some((sentence) => BUYBACK_STEMS[action].some((stem) => sentence.includes(stem)));
    if (found) return action;
    this.dropped.push('buyback.action');
    return undefined;
  }

  dividend(claimed: ClaimedDividend | undefined): VerifiedDividend {
    const stated = claimed?.announced === true || claimed?.perShare !== undefined || claimed?.action !== undefined;
    if (claimed === undefined || !stated) return { status: dividendMentioned(this.text) ? 'not-found' : 'none' };
    const perShare = this.amount('dividend.perShare', claimed.perShare, perShareAmount);
    const action = this.dividendAction(claimed.action);
    const announced = perShare !== undefined || action === 'suspended' || action === 'initiated';
    return dropUndefined({
      status: announced ? ('announced' as const) : ('not-found' as const),
      perShare,
      previousPerShare: this.amount('dividend.previousPerShare', claimed.previousPerShare, perShareAmount),
      action,
      frequency: this.frequency(claimed.frequency),
      exDate: this.date('exDate', claimed.exDate),
      recordDate: this.date('recordDate', claimed.recordDate),
      payDate: this.date('payDate', claimed.payDate),
    });
  }

  buyback(claimed: ClaimedBuyback | undefined): VerifiedBuyback {
    const stated = claimed?.mentioned === true || claimed?.authorization !== undefined || claimed?.repurchased !== undefined || claimed?.repurchasedShares !== undefined || claimed?.remaining !== undefined;
    if (claimed === undefined || !stated) return { status: buybackMentioned(this.text) ? 'not-found' : 'none' };
    const authorization = this.amount('buyback.authorization', claimed.authorization, moneyAmount);
    const repurchased = this.amount('buyback.repurchased', claimed.repurchased, moneyAmount);
    const repurchasedShares = this.amount('buyback.repurchasedShares', withoutShareWord(claimed.repurchasedShares), shareCount);
    const remaining = this.amount('buyback.remaining', claimed.remaining, moneyAmount);
    if ([authorization, repurchased, repurchasedShares, remaining].every((value) => value === undefined)) return { status: 'not-found' };
    // Without a program size the release talks about an existing program: nothing new or increased to verify.
    const action = authorization === undefined ? ('ongoing' as const) : this.buybackAction(claimed.action);
    return dropUndefined({ status: 'announced' as const, action, authorization, repurchased, repurchasedShares, remaining });
  }
}

/** Verifies the dividend and buyback blocks of an extraction against the release text. `index` is reused when the caller already built it. Pure. */
export function verifyCapitalReturn(extraction: Pick<Extraction, 'dividend' | 'buyback'>, text: string, reportDate: string, index?: NumberIndex): VerifiedCapitalReturn {
  const verifier = new CapitalReturnVerifier(text, reportDate, index);
  const dividend = verifier.dividend(extraction.dividend);
  const buyback = verifier.buyback(extraction.buyback);
  return { dividend, buyback, dropped: verifier.dropped };
}
