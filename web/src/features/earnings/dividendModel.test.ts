import { describe, expect, it } from 'vitest';
import { sampleDemoSummaries, sampleSummary, type EarningsBuyback, type EarningsDividend } from '@portfolio/shared';
import { actionText, buybackLine, capitalReturnLines, datesText, dividendLine, upgradeText } from './dividendModel';

const plain = (text: string): string => text.replaceAll('\u00a0', ' ');
const announced = (extra: Partial<EarningsDividend> = {}): EarningsDividend => ({ status: 'announced', perShare: 0.45, currency: 'USD', ...extra });
const bought = (extra: Partial<EarningsBuyback> = {}): EarningsBuyback => ({ status: 'announced', currency: 'USD', ...extra });

describe('the dividend line', () => {
  it('words the owner example: amount, raise in percent and amount, payment and record dates as dd-mm-yyyy', () => {
    const line = dividendLine(announced({ action: 'raised', changePct: 4.7, changeAmount: 0.02, previousPerShare: 0.43, payDate: '2027-01-15', recordDate: '2027-01-02', exDate: '2027-01-02', frequency: 'quarterly' }));
    expect(line).toMatchObject({ key: 'dividend', label: 'Dividend', tone: 'announced', icon: 'up' });
    expect(plain(line.text)).toBe('US$ 0,45 per share (quarterly), raised 4,7% (+US$ 0,02), paid 15-01-2027 to holders of record 02-01-2027');
  });

  it('says N/A with the reason when the release announces none', () => {
    expect(dividendLine({ status: 'none' })).toEqual({ key: 'dividend', label: 'Dividend', text: 'N/A', note: 'No dividend announced', tone: 'none' });
  });

  it('says when the release mentions one that could not be read reliably', () => {
    expect(dividendLine({ status: 'not-found' })).toMatchObject({ tone: 'unclear', text: expect.stringContaining('could not be read reliably') });
  });

  it('shows a cut with its size, and keeps four decimals of an odd amount', () => {
    const line = dividendLine(announced({ perShare: 0.4375, action: 'cut', changePct: -12.5, changeAmount: -0.0625 }));
    expect(line.icon).toBe('down');
    expect(plain(line.text)).toBe('US$ 0,4375 per share, cut 12,5% (−US$ 0,0625)');
  });

  it('shows maintained, initiated and suspended with an icon and without an invented size', () => {
    expect(dividendLine(announced({ action: 'maintained', changePct: 0, changeAmount: 0 }))).toMatchObject({ icon: 'same' });
    expect(plain(dividendLine(announced({ action: 'maintained', changePct: 0, changeAmount: 0 })).text)).toBe('US$ 0,45 per share, maintained');
    expect(plain(dividendLine(announced({ action: 'initiated' })).text)).toBe('US$ 0,45 per share, initiated');
    expect(dividendLine(announced({ action: 'initiated' })).icon).toBe('new');
    expect(dividendLine({ status: 'announced', action: 'suspended' })).toMatchObject({ icon: 'stop', text: 'suspended' });
  });

  it('copes with a dividend that has neither amount nor action, and with only some dates', () => {
    expect(dividendLine({ status: 'announced' }).text).toBe('announced with the results');
    expect(datesText({ status: 'announced', recordDate: '2027-01-02' })).toBe('holders of record 02-01-2027');
    expect(datesText({ status: 'announced', payDate: '2027-01-15', exDate: '2027-01-02' })).toBe('paid 15-01-2027 ex-dividend 02-01-2027');
    expect(datesText({ status: 'announced' })).toBeUndefined();
    expect(actionText({ status: 'announced' })).toBeUndefined();
    expect(actionText({ status: 'announced', action: 'raised' })).toBe('raised');
    expect(plain(dividendLine(announced({ currency: undefined, action: 'cut', changeAmount: -0.1 })).text)).toBe('US$ 0,45 per share, cut (−US$ 0,10)');
  });
});

describe('the buyback line', () => {
  it('words the owner example: repurchased amount and shares, authorization remaining', () => {
    const line = buybackLine(bought({ repurchased: 120_000_000, repurchasedShares: 1_800_000, remaining: 880_000_000, authorization: 1_000_000_000 }));
    expect(line).toEqual({ key: 'buyback', label: 'Share buybacks', text: '$1B program; repurchased $120M (1.8M shares) this quarter; $880M authorization remaining', tone: 'announced' });
  });

  it('says N/A with the reason, and when the release mentions one that could not be read', () => {
    expect(buybackLine({ status: 'none' })).toEqual({ key: 'buyback', label: 'Share buybacks', text: 'N/A', note: 'No share buyback mentioned', tone: 'none' });
    expect(buybackLine({ status: 'not-found' }).tone).toBe('unclear');
  });

  it('says a new or increased program as such', () => {
    expect(buybackLine(bought({ action: 'new', authorization: 2_000_000_000, repurchased: 350_000_000 }))).toMatchObject({ icon: 'new', text: 'new $2B authorization; repurchased $350M this quarter' });
    expect(buybackLine(bought({ action: 'increased', authorization: 1_500_000_000 }))).toMatchObject({ icon: 'new', text: 'authorization increased to $1.5B' });
  });

  it('copes with shares alone and with nothing else', () => {
    expect(buybackLine(bought({ repurchasedShares: 24_000_000 })).text).toBe('repurchased 24M shares this quarter');
    expect(buybackLine(bought({ currency: undefined, repurchased: 5_000_000 })).text).toBe('repurchased $5M this quarter');
    expect(buybackLine(bought()).text).toBe('announced with the results');
  });
});

describe('the lines of a summary', () => {
  it('has both lines, in the order dividend then buybacks', () => {
    const [bank, saas] = sampleDemoSummaries();
    expect(capitalReturnLines(bank!).map((line) => line.key)).toEqual(['dividend', 'buyback']);
    expect(capitalReturnLines(saas!).map((line) => line.text)).toEqual(['N/A', 'N/A']);
  });

  it('says "not read yet" for a summary stored before the two blocks existed, one line', () => {
    const old = { ...sampleSummary({ schemaVersion: 1 }), dividend: undefined, buyback: undefined };
    expect(capitalReturnLines(old)).toEqual([{ key: 'unread', label: 'Dividend and buyback', text: 'not read yet', tone: 'unread' }]);
    expect(capitalReturnLines({ ...sampleSummary(), buyback: undefined })).toHaveLength(1);
  });
});

describe('the progress of the pass that reads stored summaries again', () => {
  const backfill = { status: 'running' as const, quarters: 4, total: 8, done: 8, stored: 8, failed: 0, planned: 2, companies: 2 };

  it('says how far it is, and when it is done', () => {
    expect(upgradeText({ ...backfill, upgrade: { total: 8, done: 3 } })).toMatch(/^Dividend and buyback: read for 3 of 8 stored quarters so far\. /);
    expect(upgradeText({ ...backfill, upgrade: { total: 8, done: 8 } })).toBe('Dividend and buyback: read for all 8 stored quarters.');
  });

  it('says nothing without such a pass', () => {
    expect(upgradeText(backfill)).toBeUndefined();
    expect(upgradeText(undefined)).toBeUndefined();
  });
});
