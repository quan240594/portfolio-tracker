import { downloadFile, numberToInput, parseNumber } from './form';

describe('parseNumber', () => {
  it('parses Dutch and plain decimals', () => {
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseNumber(' 0,25 ')).toBe(0.25);
    expect(parseNumber('7')).toBe(7);
  });

  it('returns undefined for empty or non-numeric input', () => {
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('  ')).toBeUndefined();
    expect(parseNumber('abc')).toBeUndefined();
  });
});

describe('numberToInput', () => {
  it('renders numbers and empties undefined', () => {
    expect(numberToInput(12.5)).toBe('12.5');
    expect(numberToInput(undefined)).toBe('');
  });
});

describe('downloadFile', () => {
  it('clicks a temporary link to the blob and cleans up', () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('a.csv');
      expect(this.href).toBe('blob:x');
    });
    downloadFile('a.csv', 'x', 'text/csv');
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
