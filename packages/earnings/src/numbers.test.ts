import { describe, expect, it } from 'vitest';
import { NumberIndex, nextNumber, normalizeForQuote, parseAmount, tableScales, wordsOf } from './numbers.js';

describe('nextNumber', () => {
  it('reads thousands separators and one decimal point and stops at the sentence end', () => {
    expect(nextNumber('x 1,234,567.89 y')).toMatchObject({ digits: '1234567.89', value: 1234567.89 });
    expect(nextNumber('worth $12.90.')).toMatchObject({ digits: '12.90' });
    expect(nextNumber('a 1,2 b')).toMatchObject({ digits: '1' });
    expect(nextNumber('1.2.3')).toMatchObject({ digits: '1.2' });
    expect(nextNumber('none')).toBeUndefined();
    expect(nextNumber('Q3 2026', 2)).toMatchObject({ digits: '2026' });
  });
});

describe('parseAmount', () => {
  it.each([
    ['$20.71 billion', 20_710_000_000, 'money'],
    ['20.71B', 20_710_000_000, 'plain'],
    ['€1,234.5m', 1_234_500_000, 'money'],
    ['11.8%', 11.8, 'percent'],
    ['33.0 percent', 33, 'percent'],
    ['(1.2)', -1.2, 'plain'],
    ['-$0.45', -0.45, 'money'],
    ['−3.5%', -3.5, 'percent'],
    ['EUR 4.85', 4.85, 'money'],
    ['$12.90', 12.9, 'money'],
    ['1,020 million', 1_020_000_000, 'plain'],
    ['27 thousand', 27_000, 'plain'],
    ['2.1 trillion', 2.1e12, 'plain'],
    ['4.2x', 4.2, 'plain'],
  ])('%s', (raw, value, kind) => {
    expect(parseAmount(raw)).toMatchObject({ value, kind });
  });

  it('marks losses and keeps the scale', () => {
    expect(parseAmount('(2.5) million')).toBeUndefined();
    expect(parseAmount('($2.5 million)')).toMatchObject({ value: -2_500_000, negative: true, scale: 1e6 });
  });

  it.each(['', 'n/a', 'about $5 billion to $6 billion', 'revenue was $5 billion', 'Q3 2026 revenue', '5 billion 2026', '1.2.3.4 million'])('rejects %j', (raw) => {
    expect(parseAmount(raw)).toBeUndefined();
  });
});

describe('NumberIndex', () => {
  const text = 'Revenue was $20.71 billion (in millions, except per share) | 4,303 | (295) | net loss of $12 | EPS $1.45 | margin 21.2% | 11 percent';
  const index = new NumberIndex(text);

  it('finds a figure in the same or a declared scale', () => {
    expect(index.has(parseAmount('$20.71 billion')!)).toBe(true);
    expect(index.has(parseAmount('4,303 million')!)).toBe(true);
    expect(index.has(parseAmount('$4.303 billion')!)).toBe(true);
    expect(index.has(parseAmount('$1.45')!)).toBe(true);
    expect(index.has(parseAmount('21.2%')!)).toBe(true);
    expect(index.has(parseAmount('11%')!)).toBe(true);
  });

  it('rejects what the text does not print', () => {
    expect(index.has(parseAmount('$20.72 billion')!)).toBe(false);
    expect(index.has(parseAmount('$20.71 million')!)).toBe(false);
    expect(index.has(parseAmount('$1.46')!)).toBe(false);
    expect(index.has(parseAmount('21.3%')!)).toBe(false);
  });

  it('accepts a negative figure only where it reads as a loss', () => {
    expect(index.has(parseAmount('(295) million'.replace(') million', ')'))!)).toBe(true);
    expect(index.has(parseAmount('-$12')!)).toBe(true);
    expect(index.has(parseAmount('-$20.71 billion')!)).toBe(false);
  });

  it('knows the scales of its tables and counts numbers', () => {
    expect(new NumberIndex('(in thousands) 5,000').has(parseAmount('5 million')!)).toBe(true);
    expect(new NumberIndex('(000s) 5,000').has(parseAmount('5 million')!)).toBe(true);
    expect(new NumberIndex('Amounts in EUR millions 5').has(parseAmount('5 million')!)).toBe(true);
    expect(new NumberIndex('in billions 2').has(parseAmount('2 billion')!)).toBe(true);
    expect(new NumberIndex('5,000').has(parseAmount('5 million')!)).toBe(false);
    expect(index.size).toBeGreaterThanOrEqual(7);
  });

  it('checks plain values of bullets', () => {
    expect(index.hasValue(11)).toBe(true);
    expect(index.hasValue(20_710_000_000)).toBe(true);
    expect(index.hasValue(99)).toBe(false);
  });
});

describe('text helpers', () => {
  it('splits words and normalises quotes', () => {
    expect(wordsOf("Record cloud demand, up 25% — it's $5 billion.")).toEqual(['record', 'cloud', 'demand', 'up', '25%', "it's", '$5', 'billion']);
    expect(normalizeForQuote('“Hello”  — it’s\u00a0fine')).toBe('"hello" - it\'s fine');
  });
});

describe('table scales (a linear scanner, no regex)', () => {
  it.each([
    ['(in millions, except per share)', [1e6]],
    ['(In Thousands)', [1e3]],
    ['Amounts in USD millions', [1e6]],
    ['(in $ billions)', [1e9]],
    ['($ thousands)', [1e3]],
    ['(USD millions)', [1e6]],
    ['(Millions)', [1e6]],
    ['(000s)', [1e3]],
    ["( $ 000's )", [1e3]],
    ['in thousands, later (in millions)', [1e3, 1e6]],
    ['within millions of customers', []],
    ['in several millions', []],
    ['in millionsx', []],
    ['(000 s)', []],
    ['(000s', []],
    ['in ab millions', []],
    ['', []],
  ])('%j gives %j', (text, expected) => {
    expect([...tableScales(text)].sort((a, b) => a - b)).toEqual(expected);
  });

  it('keeps thousands separators, parentheses negatives, scale words, percent and ranges working through the index', () => {
    const index = new NumberIndex('Revenue $1,234.5 million; net loss (295); growth 11.8%; range 5-6 billion; (in millions) 4,303');
    expect(index.has(parseAmount('$1,234.5 million')!)).toBe(true);
    expect(index.has(parseAmount('$1.2345 billion')!)).toBe(true);
    expect(index.has(parseAmount('(295)')!)).toBe(true);
    expect(index.has(parseAmount('11.8%')!)).toBe(true);
    expect(index.has(parseAmount('6 billion')!)).toBe(true);
    expect(index.has(parseAmount('$4.303 billion')!)).toBe(true);
    expect(parseAmount('5-6 billion')).toBeUndefined();
    expect(parseAmount('$5 to 6 billion')).toBeUndefined();
  });

  it('finishes quickly on adversarial runs of digits, spaces, parentheses and punctuation', () => {
    const size = 50_000;
    const attacks = [
      `(${' '.repeat(size)}x`,
      `in${' '.repeat(size)}x`,
      `in${' $ '.repeat(size / 3)}`,
      '('.repeat(size),
      'in '.repeat(size / 3),
      `(${' '.repeat(size)}$${' '.repeat(size)}000`,
      `(in${' '.repeat(size)}USD${' '.repeat(size)}`,
      '1,'.repeat(size / 2),
      '1 '.repeat(size / 2),
      `${'9'.repeat(size)}.`,
      `$${' '.repeat(size)}5${' '.repeat(size)}%`,
      "'.-".repeat(size / 3),
      `a${".'-".repeat(size / 3)}a`,
    ];
    const started = performance.now();
    for (const attack of attacks) {
      tableScales(attack);
      new NumberIndex(attack);
      parseAmount(attack);
      wordsOf(attack);
      normalizeForQuote(attack);
    }
    // Locally this takes about 0.1 s. Catastrophic backtracking on these inputs would take minutes, so the budget only has to sit far
    // above the noise of a shared CI runner that also instruments the code for coverage (a 2 s budget failed there at 2.8 s).
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it('trims dots, apostrophes and hyphens at the edges of words only', () => {
    expect(wordsOf("--up-- ..well.. '5' a-b.c 'x' ---")).toEqual(['up', 'well', 'a-b.c']);
    expect(normalizeForQuote('a\u00a0\u00a0b\u2003c')).toBe('a b c');
  });
});
