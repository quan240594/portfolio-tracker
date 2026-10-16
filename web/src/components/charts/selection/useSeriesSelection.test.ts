import { act, renderHook } from '@testing-library/react';
import { useSeriesSelection, useSliceSelection } from './useSeriesSelection';

describe('useSeriesSelection', () => {
  it('starts with everything visible', () => {
    const { result } = renderHook(() => useSeriesSelection(['a', 'b'], ['r1', 'r2']));
    expect(result.current.hasHidden).toBe(false);
    expect(result.current.nothingSelected).toBe(false);
    expect(result.current.isSeriesVisible('a')).toBe(true);
    expect(result.current.isRowVisible('r1')).toBe(true);
  });

  it('toggles series and rows independently and resets both', () => {
    const { result } = renderHook(() => useSeriesSelection(['a', 'b'], ['r1', 'r2']));
    act(() => result.current.toggleSeries('a'));
    act(() => result.current.toggleRow('r2'));
    expect(result.current.isSeriesVisible('a')).toBe(false);
    expect(result.current.isSeriesVisible('b')).toBe(true);
    expect(result.current.isRowVisible('r2')).toBe(false);
    expect(result.current.hasHidden).toBe(true);
    expect([...result.current.hiddenSeries]).toEqual(['a']);
    expect([...result.current.hiddenRows]).toEqual(['r2']);
    act(() => result.current.toggleSeries('a'));
    expect(result.current.isSeriesVisible('a')).toBe(true);
    act(() => result.current.toggleSeries('a'));
    act(() => result.current.reset());
    expect(result.current.hasHidden).toBe(false);
  });

  it('allows hiding the last visible series and reports that nothing is selected', () => {
    const { result } = renderHook(() => useSeriesSelection(['a', 'b'], ['r1']));
    act(() => result.current.toggleSeries('a'));
    expect(result.current.nothingSelected).toBe(false);
    act(() => result.current.toggleSeries('b'));
    expect(result.current.nothingSelected).toBe(true);
    act(() => result.current.reset());
    act(() => result.current.toggleRow('r1'));
    expect(result.current.nothingSelected).toBe(true);
  });

  it('drops hidden keys that leave the data, keeps the ones that stay and does not bring a dropped key back hidden', () => {
    const { result, rerender } = renderHook(({ series, rows }) => useSeriesSelection(series, rows), { initialProps: { series: ['a', 'b'], rows: ['x', 'y'] } });
    act(() => result.current.toggleSeries('a'));
    act(() => result.current.toggleSeries('b'));
    act(() => result.current.toggleRow('x'));
    rerender({ series: ['a'], rows: ['x', 'z'] });
    expect(result.current.isSeriesVisible('a')).toBe(false);
    expect(result.current.isRowVisible('x')).toBe(false);
    rerender({ series: ['a', 'b'], rows: ['x', 'y'] });
    expect(result.current.isSeriesVisible('b')).toBe(true);
    expect(result.current.hiddenSeries.has('b')).toBe(false);
  });

  it('keeps a stable result while the key lists keep their content', () => {
    const { result, rerender } = renderHook(() => useSeriesSelection(['a'], ['x']));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('copes with empty key lists', () => {
    const { result } = renderHook(() => useSeriesSelection([]));
    expect(result.current.nothingSelected).toBe(false);
    expect(result.current.hasHidden).toBe(false);
  });
});

describe('useSliceSelection', () => {
  it('shares one state between the legend (series) and the table (rows)', () => {
    const { result } = renderHook(() => useSliceSelection(['a', 'b']));
    act(() => result.current.toggleSeries('a'));
    expect(result.current.isRowVisible('a')).toBe(false);
    act(() => result.current.toggleRow('b'));
    expect(result.current.isSeriesVisible('b')).toBe(false);
    expect(result.current.nothingSelected).toBe(true);
    expect(result.current.hiddenRows).toBe(result.current.hiddenSeries);
    act(() => result.current.reset());
    expect(result.current.hasHidden).toBe(false);
    expect(result.current.nothingSelected).toBe(false);
  });

  it('forgets slices that disappear', () => {
    const { result, rerender } = renderHook(({ keys }) => useSliceSelection(keys), { initialProps: { keys: ['a', 'b'] } });
    act(() => result.current.toggleSeries('a'));
    rerender({ keys: ['b'] });
    expect(result.current.hasHidden).toBe(false);
  });
});
