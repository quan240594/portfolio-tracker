import { describe, expect, it } from 'vitest';
import { buybackOf, dividendOf, dividendWithPrevious } from './capital-derive.js';
import { buybackMentioned, dividendMentioned, verifyCapitalReturn } from './capital-return.js';
import { parsePrintedDate, withinDays } from './printed-date.js';
import { extractionSchema } from './schema.js';
import { sampleSummary } from '@portfolio/shared';
import { BUYBACK_ONLY_RELEASE, DIVIDEND_CUT_RELEASE, DIVIDEND_RAISE_RELEASE, MESSY_CAPITAL_RELEASE, NO_DIVIDEND_RELEASE } from './testing/capital-return-fixtures.js';
import { buildReleaseSummary } from './testing/summary.js';

describe('parsePrintedDate', () => {
  it.each([
    ['January 15, 2027', '2027-01-15'],
    ['Jan. 15th, 2027', '2027-01-15'],
    ['15 January 2027', '2027-01-15'],
    ['on the 2nd of March 2027', '2027-03-02'],
    ['Sept 9, 2026', '2026-09-09'],
    ['2027-01-15', '2027-01-15'],
    ['1/15/2027', '2027-01-15'],
    ['15/1/2027', '2027-01-15'],
    ['12/11/2026', '2026-12-11'],
    ['15.01.2027', '2027-01-15'],
  ])('reads %s', (raw, iso) => {
    expect(parsePrintedDate(raw, '2026-10-28')).toBe(iso);
  });

  it('puts a date without a year after the release date, next year when it is already past', () => {
    expect(parsePrintedDate('January 15', '2026-10-28')).toBe('2027-01-15');
    expect(parsePrintedDate('November 20', '2026-10-28')).toBe('2026-11-20');
    expect(parsePrintedDate('October 10', '2026-10-28')).toBe('2026-10-10');
    expect(parsePrintedDate('February 29', '2027-03-01')).toBeUndefined();
  });

  it.each(['', 'soon', 'January', '15', 'February 30, 2027', 'January 15 and 16, 2027', '13/13/2026', '1/2/27', 'Smarch 4, 2026', '2027-13-01', 'June 7th 8th'])('rejects %j', (raw) => {
    expect(parsePrintedDate(raw, '2026-10-28')).toBeUndefined();
  });

  it('knows when a date is near the release', () => {
    expect(withinDays('2027-01-15', '2026-10-28', 400)).toBe(true);
    expect(withinDays('2028-01-15', '2026-10-28', 400)).toBe(false);
    expect(withinDays('2025-01-01', '2026-10-28', 400)).toBe(false);
  });
});

describe('the dividend and buyback of the invented releases', () => {
  it('reads a raised dividend and repurchases (a REIT like the owner holds), with the raise computed from the printed amounts', () => {
    const { summary, dropped } = buildReleaseSummary(DIVIDEND_RAISE_RELEASE);
    expect(dropped).toEqual([]);
    expect(summary.schemaVersion).toBe(2);
    expect(summary.dividend).toEqual({
      status: 'announced',
      perShare: 0.45,
      raw: '$0.45',
      currency: 'USD',
      action: 'raised',
      actionSource: 'computed',
      previousPerShare: 0.43,
      previousSource: 'release',
      changePct: 4.7,
      changeAmount: 0.02,
      frequency: 'quarterly',
      exDate: '2027-01-02',
      recordDate: '2027-01-02',
      payDate: '2027-01-15',
    });
    expect(summary.buyback).toEqual({
      status: 'announced',
      currency: 'USD',
      authorization: 1_000_000_000,
      authorizationRaw: '$1.0 billion',
      repurchased: 120_000_000,
      repurchasedRaw: '$120 million',
      repurchasedShares: 1_800_000,
      remaining: 880_000_000,
      remainingRaw: '$880 million',
    });
  });

  it('says none for a company that announces neither', () => {
    const { summary } = buildReleaseSummary(NO_DIVIDEND_RELEASE);
    expect(summary.dividend).toEqual({ status: 'none' });
    expect(summary.buyback).toEqual({ status: 'none' });
  });

  it('reads a buyback-only release: a new program, the amount bought back, no dividend', () => {
    const { summary } = buildReleaseSummary(BUYBACK_ONLY_RELEASE);
    expect(summary.dividend).toEqual({ status: 'none' });
    expect(summary.buyback).toMatchObject({ status: 'announced', action: 'new', authorization: 2_000_000_000, repurchased: 350_000_000 });
    expect(summary.buyback).not.toHaveProperty('remaining');
  });

  it('computes a cut from the printed previous amount, whatever adjective the model used', () => {
    const { summary } = buildReleaseSummary(DIVIDEND_CUT_RELEASE);
    expect(summary.dividend).toMatchObject({ status: 'announced', perShare: 0.3, action: 'cut', actionSource: 'computed', previousPerShare: 0.6, changePct: -50, changeAmount: -0.3, recordDate: '2026-11-20', payDate: '2026-12-12' });
    const wrong = extractionSchema.parse({ ...DIVIDEND_CUT_RELEASE.extraction, dividend: { announced: true, perShare: '$0.30', previousPerShare: '$0.60', action: 'increased', frequency: 'quarterly' } });
    const text = buildReleaseSummary(DIVIDEND_CUT_RELEASE).text;
    const verified = verifyCapitalReturn(wrong, text, '2026-10-27');
    expect(verified.dividend.action).toBeUndefined();
    expect(verified.dropped).toContain('dividend.action');
    expect(dividendOf(verified.dividend, 'USD', undefined)).toMatchObject({ action: 'cut', actionSource: 'computed' });
  });

  it('reads a messy release: year-less dates, four decimals, a share count in digits; raised against the previous stored summary', () => {
    const previous = sampleSummary({ symbol: 'HRTD', reportDate: '2026-07-27', dividend: { status: 'announced', perShare: 0.43, currency: 'USD', frequency: 'quarterly' } });
    const { summary } = buildReleaseSummary(MESSY_CAPITAL_RELEASE, undefined, previous);
    expect(summary.dividend).toMatchObject({ status: 'announced', perShare: 0.45, action: 'raised', actionSource: 'computed', previousPerShare: 0.43, previousSource: 'stored', changePct: 4.7, changeAmount: 0.02, recordDate: '2027-01-02', payDate: '2027-01-15' });
    expect(summary.buyback).toMatchObject({ status: 'announced', action: 'ongoing', repurchased: 120_000_000, repurchasedShares: 1_800_000, remaining: 880_000_000 });
    expect(summary.buyback).not.toHaveProperty('authorization');
  });

  it('falls back to the release wording only when the release says it and no two amounts exist', () => {
    const { summary } = buildReleaseSummary(MESSY_CAPITAL_RELEASE);
    expect(summary.dividend).toMatchObject({ status: 'announced', perShare: 0.45, action: 'raised', actionSource: 'stated' });
    expect(summary.dividend).not.toHaveProperty('changePct');
  });
});

describe('verification of the dividend', () => {
  const text = buildReleaseSummary(DIVIDEND_RAISE_RELEASE).text;
  const verify = (dividend: unknown, buyback?: unknown) => verifyCapitalReturn(extractionSchema.parse({ dividend, buyback }), text, '2026-10-28');

  it('drops an amount that is not in the release and says there is none read', () => {
    const result = verify({ announced: true, perShare: '$0.52', frequency: 'quarterly' });
    expect(result.dividend).toEqual({ status: 'not-found', frequency: 'quarterly' });
    expect(result.dropped).toEqual(['dividend.perShare']);
  });

  it('drops dates that are not printed, do not parse or are far from the release', () => {
    const result = verify({ announced: true, perShare: '$0.45', exDate: 'January 3, 2027', recordDate: 'next month', payDate: 'January 15, 2031' });
    expect(result.dividend).toEqual({ status: 'announced', perShare: expect.objectContaining({ value: 0.45 }) });
    expect(result.dropped).toEqual(['dividend.exDate', 'dividend.recordDate', 'dividend.payDate']);
  });

  it('refuses an action or a frequency the dividend sentences do not contain', () => {
    const result = verify({ announced: true, perShare: '$0.45', action: 'suspended', frequency: 'monthly' });
    expect(result.dividend.action).toBeUndefined();
    expect(result.dividend.frequency).toBeUndefined();
    expect(result.dropped).toEqual(['dividend.action', 'dividend.frequency']);
    expect(verify({ announced: true, perShare: '$0.45', action: 'splendid' }).dropped).toEqual(['dividend.action']);
  });

  it('refuses percentages, scaled amounts and absurd per-share amounts', () => {
    expect(verify({ perShare: '4.7%' }).dividend.status).toBe('not-found');
    expect(verify({ perShare: '$120 million' }).dividend.status).toBe('not-found');
    expect(verify({ perShare: '$1,020' }).dividend.status).toBe('not-found');
  });

  it('says none when the model found nothing and the release has no dividend amount, not-found when it has one', () => {
    expect(verify(undefined).dividend).toEqual({ status: 'not-found' });
    expect(verifyCapitalReturn({}, buildReleaseSummary(NO_DIVIDEND_RELEASE).text, '2026-10-22').dividend).toEqual({ status: 'none' });
    expect(verifyCapitalReturn(extractionSchema.parse({ dividend: { announced: false } }), buildReleaseSummary(NO_DIVIDEND_RELEASE).text, '2026-10-22').dividend).toEqual({ status: 'none' });
    expect(verify({ announced: false }).dividend).toEqual({ status: 'not-found' });
  });

  it('keeps a suspension that has no amount, and an initiation the release words as such', () => {
    const release = 'Revenue of $1 billion in the quarter. The Board suspended the quarterly dividend until further notice. The company initiated a dividend program.';
    const suspended = verifyCapitalReturn(extractionSchema.parse({ dividend: { announced: true, action: 'suspended' } }), release, '2026-10-28');
    expect(suspended.dividend).toEqual({ status: 'announced', action: 'suspended' });
    expect(dividendOf(suspended.dividend, 'USD', undefined)).toEqual({ status: 'announced', currency: 'USD', action: 'suspended', actionSource: 'stated' });
    const initiated = verifyCapitalReturn(extractionSchema.parse({ dividend: { announced: true, action: 'initiated' } }), release, '2026-10-28');
    expect(initiated.dividend.status).toBe('announced');
  });
});

describe('verification of the buyback', () => {
  const text = buildReleaseSummary(DIVIDEND_RAISE_RELEASE).text;
  const verify = (buyback: unknown) => verifyCapitalReturn(extractionSchema.parse({ buyback }), text, '2026-10-28');

  it('drops amounts that are not in the release; with nothing left it is not-found', () => {
    expect(verify({ mentioned: true, repurchased: '$999 million' }).buyback).toEqual({ status: 'not-found' });
    const partial = verify({ mentioned: true, repurchased: '$120 million', remaining: '$777 million' });
    expect(partial.buyback).toMatchObject({ status: 'announced', action: 'ongoing' });
    expect(partial.dropped).toEqual(['buyback.remaining']);
  });

  it('wants a share count to be a plain number and money to be money', () => {
    expect(verify({ mentioned: true, repurchasedShares: '$120 million' }).buyback.status).toBe('not-found');
    expect(verify({ mentioned: true, repurchased: '1.8 million' }).buyback.repurchased?.value).toBe(1_800_000);
    expect(verify({ mentioned: true, repurchasedShares: '1.8 million shares' }).buyback.repurchasedShares?.value).toBe(1_800_000);
    expect(verify({ mentioned: true, repurchasedShares: ' 1.8 million  common   shares ' }).buyback.repurchasedShares?.value).toBe(1_800_000);
  });

  it('keeps new or increased only when a sentence about the repurchase says so', () => {
    expect(verify({ mentioned: true, authorization: '$1.0 billion', action: 'new' }).buyback.action).toBeUndefined();
    const raised = verifyCapitalReturn(
      extractionSchema.parse({ buyback: { mentioned: true, authorization: '$1.5 billion', action: 'increased' } }),
      'The Board increased the share repurchase authorization by $500 million to a total of $1.5 billion in the quarter.',
      '2026-10-28',
    );
    expect(raised.buyback).toMatchObject({ status: 'announced', action: 'increased' });
    expect(verify({ mentioned: true, authorization: '$1.0 billion', action: 'ongoing' }).buyback.action).toBe('ongoing');
  });

  it('says none without a mention, not-found when the release states an amount the model did not read', () => {
    expect(verifyCapitalReturn({}, buildReleaseSummary(NO_DIVIDEND_RELEASE).text, '2026-10-22').buyback).toEqual({ status: 'none' });
    expect(verify(undefined).buyback).toEqual({ status: 'not-found' });
    expect(verify({ mentioned: false }).buyback).toEqual({ status: 'not-found' });
  });
});

describe('what counts as a mention', () => {
  it('needs an amount in the same sentence', () => {
    expect(dividendMentioned('The Board declared a dividend of $0.20 per share.')).toBe(true);
    expect(dividendMentioned('Dividend yield | $ 0.20')).toBe(false);
    expect(dividendMentioned('Dividend payable | $ 0.20')).toBe(true);
    expect(dividendMentioned('The company does not pay a dividend.')).toBe(false);
    expect(dividendMentioned('Dividends paid | $ (120)')).toBe(false);
    expect(buybackMentioned('It repurchased $5 million of stock.')).toBe(true);
    expect(buybackMentioned('A share repurchase program is in place.')).toBe(false);
    expect(buybackMentioned('It repurchased € 5 million of stock.')).toBe(true);
  });
});

describe('the comparison with the previous dividend', () => {
  const announced = (perShare: number, extra = {}) => ({ status: 'announced' as const, perShare, currency: 'USD', frequency: 'quarterly' as const, ...extra });
  const before = (perShare: number, extra = {}) => sampleSummary({ dividend: announced(perShare, extra) });

  it('raises, cuts and maintains by arithmetic, with a tolerance for rounding', () => {
    expect(dividendWithPrevious(announced(0.46), before(0.4))).toMatchObject({ action: 'raised', changePct: 15, changeAmount: 0.06, previousPerShare: 0.4, previousSource: 'stored' });
    expect(dividendWithPrevious(announced(0.3), before(0.4))).toMatchObject({ action: 'cut', changePct: -25, changeAmount: -0.1 });
    expect(dividendWithPrevious(announced(0.4), before(0.4))).toMatchObject({ action: 'maintained', changePct: 0, changeAmount: 0 });
    expect(dividendWithPrevious(announced(0.40001), before(0.4))).toMatchObject({ action: 'maintained' });
  });

  it('does not compare across currencies, with a special dividend or with nothing', () => {
    expect(dividendWithPrevious(announced(0.5), sampleSummary({ dividend: announced(0.4, { currency: 'EUR' }) }))).toEqual(announced(0.5));
    expect(dividendWithPrevious(announced(0.5), before(0.4, { frequency: 'special' }))).toEqual(announced(0.5));
    expect(dividendWithPrevious(announced(0.5, { frequency: 'special' }), before(0.4))).toEqual(announced(0.5, { frequency: 'special' }));
    expect(dividendWithPrevious(announced(0.5), sampleSummary({ dividend: { status: 'none' } }))).toEqual(announced(0.5));
    expect(dividendWithPrevious(announced(0.5), undefined)).toEqual(announced(0.5));
    expect(dividendWithPrevious(announced(0.5), before(0))).toEqual(announced(0.5));
    expect(dividendWithPrevious({ status: 'none' }, before(0.4))).toEqual({ status: 'none' });
  });

  it('is idempotent, replaces its own earlier answer, and keeps what the release printed or said', () => {
    const once = dividendWithPrevious(announced(0.46), before(0.4));
    expect(dividendWithPrevious(once, before(0.4))).toEqual(once);
    expect(dividendWithPrevious(once, before(0.46))).toMatchObject({ action: 'maintained' });
    expect(dividendWithPrevious(once, undefined)).toEqual(announced(0.46));
    const printed = { ...announced(0.46), action: 'raised' as const, actionSource: 'computed' as const, previousPerShare: 0.43, previousSource: 'release' as const, changePct: 7 };
    expect(dividendWithPrevious(printed, before(0.1))).toBe(printed);
    const stated = announced(0.46, { action: 'raised', actionSource: 'stated' });
    expect(dividendWithPrevious(stated, undefined)).toEqual(stated);
    expect(dividendWithPrevious(stated, before(0.5))).toMatchObject({ action: 'cut', actionSource: 'computed' });
  });

  it('builds the blocks from verified values', () => {
    expect(dividendOf({ status: 'none' }, 'USD', undefined)).toEqual({ status: 'none' });
    expect(dividendOf({ status: 'not-found' }, 'USD', undefined)).toEqual({ status: 'not-found' });
    expect(buybackOf({ status: 'none' }, 'USD')).toEqual({ status: 'none' });
    expect(buybackOf({ status: 'not-found' }, 'USD')).toEqual({ status: 'not-found' });
  });
});
