import { FOCUS_DIM, focusOpacity, isFocused, maskSeries, selectRows, stableColours, visibleKeys, visibleSliceTotal, visibleSlices, visibleTotal } from './selectionAdapter';

const hide = (...hidden: string[]) => ({ isSeriesVisible: (k: string) => !hidden.includes(k), isRowVisible: (k: string) => !hidden.includes(k) });
const rows = [
  { id: 'a', x: 1, y: 2 },
  { id: 'b', x: 3, y: 4 },
];

describe('selection adapter', () => {
  it('filters rows by id', () => {
    expect(selectRows(rows, (r) => r.id, hide('a'))).toEqual([rows[1]]);
    expect(selectRows(rows, (r) => r.id, hide())).toEqual(rows);
  });

  it('keeps the visible series keys in order', () => {
    expect(visibleKeys(['x', 'y', 'z'], hide('y'))).toEqual(['x', 'z']);
  });

  it('gives each key its colour by position among all keys, wrapping around the palette', () => {
    expect(stableColours(['a', 'b', 'c'], ['#1', '#2'])).toEqual({ a: '#1', b: '#2', c: '#1' });
  });

  it('masks hidden series fields without touching the original, and returns the row itself when nothing is hidden', () => {
    const row = rows[0]!;
    expect(maskSeries(row, ['x', 'y'], hide('y'))).toEqual({ id: 'a', x: 1, y: undefined });
    expect(row.y).toBe(2);
    expect(maskSeries(row, ['x', 'y'], hide())).toBe(row);
  });

  it('totals the visible numeric series only', () => {
    expect(visibleTotal({ x: 1, y: 2, z: undefined, w: 'n/a' }, ['x', 'y', 'z', 'w'], hide())).toBe(3);
    expect(visibleTotal({ x: 1, y: 2 }, ['x', 'y'], hide('x'))).toBe(2);
    expect(visibleTotal({ x: 1 }, ['x'], hide('x'))).toBe(0);
  });

  it('recomputes slice shares over the visible slices', () => {
    const slices = [
      { key: 'a', value: 50 },
      { key: 'b', value: 30 },
      { key: 'c', value: 20 },
    ];
    expect(visibleSlices(slices, hide()).map((s) => s.share)).toEqual([0.5, 0.3, 0.2]);
    expect(visibleSlices(slices, hide('a')).map((s) => [s.key, s.share])).toEqual([
      ['b', 0.6],
      ['c', 0.4],
    ]);
    expect(visibleSlices(slices, hide('a', 'b', 'c'))).toEqual([]);
    expect(visibleSlices([{ key: 'z', value: 0 }], hide())[0]!.share).toBe(0);
    expect(visibleSliceTotal(slices, hide('a'))).toBe(50);
  });
});

describe('legend focus helpers', () => {
  it('treats everything as focused while nothing is previewed', () => {
    expect(isFocused(null, 'a')).toBe(true);
    expect(isFocused(undefined, ['a', 'b'])).toBe(true);
    expect(focusOpacity(null, 'a')).toBe(1);
    expect(focusOpacity(undefined, ['x'])).toBe(1);
  });

  it('matches an element by its one key or by any of the legend entries it belongs to', () => {
    expect(isFocused('a', 'a')).toBe(true);
    expect(isFocused('a', 'b')).toBe(false);
    expect(isFocused('declared', ['2026', 'declared', '2026-forecast'])).toBe(true);
    expect(isFocused('2027', ['2026', 'declared', '2026-forecast'])).toBe(false);
    expect(isFocused('a', [])).toBe(false);
  });

  it('dims what does not belong to the previewed entry, by default or by the given amount', () => {
    expect(focusOpacity('a', 'a')).toBe(1);
    expect(focusOpacity('a', 'b')).toBe(FOCUS_DIM);
    expect(focusOpacity('a', ['b', 'c'], 0.5)).toBe(0.5);
    expect(FOCUS_DIM).toBeGreaterThan(0);
    expect(FOCUS_DIM).toBeLessThan(1);
  });
});
