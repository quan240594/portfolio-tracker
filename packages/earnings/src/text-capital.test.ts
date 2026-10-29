import { describe, expect, it } from 'vitest';
import { FULL_RELEASE_CHARS, HEAD_CHARS, MAX_PASSAGE_CHARS, MAX_RELEASE_CHARS, capText, capitalReturnPassages, capitalReturnText, htmlToText, mentionsCapitalReturn, textWithCapitalReturn } from './text.js';

const filler = (lines: number): string => Array.from({ length: lines }, (_, index) => `Segment ${index} revenue grew as customers added new capacity in the region during the period under review.`).join('\n');

describe('passages about dividends and repurchases', () => {
  it('recognises the keywords in any case', () => {
    for (const line of ['Dividend declared', 'share REPURCHASE plan', 'a buyback', 'a buy-back', 'we buy back shares', 'Repurchases of common stock']) expect(mentionsCapitalReturn(line)).toBe(true);
    expect(mentionsCapitalReturn('Revenue grew')).toBe(false);
  });

  it('picks the lines, the line after a prose line, in document order, and skips what the model already reads', () => {
    const text = ['Intro line without keywords', 'The Board declared a quarterly dividend of $0.45 per share to holders of record.', 'Payable on January 15, 2027.', 'Dividends paid | (120)', 'Other'].join('\n');
    expect(capitalReturnPassages(text)).toBe(['The Board declared a quarterly dividend of $0.45 per share to holders of record.', 'Payable on January 15, 2027.', 'Dividends paid | (120)'].join('\n'));
    expect(capitalReturnPassages(text, { skip: new Set(['Dividends paid | (120)']) })).not.toContain('Dividends paid');
    expect(capitalReturnPassages('no keywords here')).toBe('');
  });

  it('prefers prose to table rows when the budget is short and cuts long lines', () => {
    const prose = `The company repurchased shares. ${'x'.repeat(100)}`;
    const text = ['Repurchases | (1)', prose, 'Dividends | (2)'].join('\n');
    expect(capitalReturnPassages(text, { max: prose.length + 2 })).toBe(prose);
    const long = `Dividend ${'y'.repeat(2000)}`;
    expect(capitalReturnPassages(long)).toHaveLength(500);
  });

  it('keeps at most the budget', () => {
    const many = Array.from({ length: 200 }, (_, index) => `The Board declared dividend number ${index} of $0.45 per share to holders of record.`).join('\n');
    expect(capitalReturnPassages(many).length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS);
  });

  it('leaves the text alone when the cap cut nothing, and adds what the cap cut off when it did', () => {
    const short = 'Revenue was $5 billion.\nThe Board declared a dividend of $0.45 per share.';
    expect(textWithCapitalReturn(short)).toBe(short);
    const long = `${filler(900)}\nThe Board declared a quarterly dividend of $0.45 per share payable on January 15, 2027.\nThe company repurchased $120 million of its shares.\n${filler(10)}`;
    const capped = capText(long);
    expect(capped).not.toContain('declared a quarterly dividend');
    const text = textWithCapitalReturn(long);
    expect(text.startsWith(capped)).toBe(true);
    expect(text).toContain('Further passages about dividends and share repurchases:\nThe Board declared a quarterly dividend of $0.45 per share payable on January 15, 2027.');
    expect(text).toContain('repurchased $120 million');
  });

  it('adds nothing when the cut text had no passage', () => {
    const long = filler(900);
    expect(long.length).toBeGreaterThan(MAX_RELEASE_CHARS);
    expect(textWithCapitalReturn(long)).toBe(capText(long));
  });

  it('builds the small text of the focused question: the first lines and the passages, a few thousand characters', () => {
    const long = `${filler(900)}\nThe Board declared a quarterly dividend of $0.45 per share.\n${filler(3)}`;
    const text = capitalReturnText(long);
    expect(text.length).toBeLessThan(HEAD_CHARS + MAX_PASSAGE_CHARS + 200);
    expect(text.startsWith('Segment 0 revenue')).toBe(true);
    expect(text).toContain('Passages about dividends and share repurchases:\nThe Board declared a quarterly dividend');
    expect(capitalReturnText(filler(3))).toBe(filler(3));
  });

  it('keeps the whole release up to the full limit when it is asked to', () => {
    const html = `<html><body>${Array.from({ length: 700 }, (_, index) => `<p>Paragraph ${index} about revenue and the quarter with several words to fill the line well past sixty characters.</p>`).join('')}<p>Dividend of $0.45 per share</p></body></html>`;
    expect(htmlToText(html, FULL_RELEASE_CHARS)).toContain('Dividend of $0.45 per share');
    expect(htmlToText(html)).not.toContain('Dividend of $0.45 per share');
  });
});
