import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  afterEach(() => vi.useRealTimers());

  it('follows the value only after it has been stable for the delay', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 400), { initialProps: { value: 'a' } });
    expect(result.current).toBe('a');
    rerender({ value: 'b' });
    act(() => vi.advanceTimersByTime(300));
    rerender({ value: 'c' });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe('a');
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe('c');
  });
});
