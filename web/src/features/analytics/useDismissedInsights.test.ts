import { act, renderHook } from '@testing-library/react';
import { DISMISSED_INSIGHTS_KEY, useDismissedInsights } from './useDismissedInsights';

describe('useDismissedInsights', () => {
  it('stores dismissals in sessionStorage and restores them', () => {
    const { result } = renderHook(() => useDismissedInsights());
    expect(result.current.dismissed).toEqual([]);
    act(() => result.current.dismiss('all:a'));
    act(() => result.current.dismiss('all:b'));
    act(() => result.current.dismiss('all:a'));
    expect(result.current.dismissed).toEqual(['all:a', 'all:b']);
    expect(JSON.parse(sessionStorage.getItem(DISMISSED_INSIGHTS_KEY)!)).toEqual(['all:a', 'all:b']);
    expect(renderHook(() => useDismissedInsights()).result.current.dismissed).toEqual(['all:a', 'all:b']);

    act(() => result.current.restore(['all:a']));
    expect(result.current.dismissed).toEqual(['all:b']);
  });

  it('ignores corrupt or foreign storage content', () => {
    sessionStorage.setItem(DISMISSED_INSIGHTS_KEY, '{oops');
    expect(renderHook(() => useDismissedInsights()).result.current.dismissed).toEqual([]);
    sessionStorage.setItem(DISMISSED_INSIGHTS_KEY, '{"a":1}');
    expect(renderHook(() => useDismissedInsights()).result.current.dismissed).toEqual([]);
    sessionStorage.setItem(DISMISSED_INSIGHTS_KEY, '["ok", 3, null]');
    expect(renderHook(() => useDismissedInsights()).result.current.dismissed).toEqual(['ok']);
  });

  it('keeps working in memory when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { result } = renderHook(() => useDismissedInsights());
    act(() => result.current.dismiss('all:a'));
    expect(result.current.dismissed).toEqual(['all:a']);
  });
});
