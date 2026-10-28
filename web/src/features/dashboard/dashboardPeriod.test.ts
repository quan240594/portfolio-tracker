import { PERIOD_LABELS, PERIOD_OPTIONS, PERIOD_STORAGE_KEY, coverageLabel, queryPeriod, readStoredPeriod, useDashboardPeriod } from './dashboardPeriod';
import { act, renderHook } from '@testing-library/react';
import { formatDate } from '../../lib/format';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('dashboard period', () => {
  it('offers TTM, YTD, 5 years, 10 years and All time', () => {
    expect(PERIOD_OPTIONS.map((o) => o.label)).toEqual(['TTM', 'YTD', '5 years', '10 years', 'All time']);
    expect(PERIOD_LABELS.all).toBe('All time');
  });

  it('defaults to all time and keeps the choice in localStorage', () => {
    expect(readStoredPeriod()).toBe('all');
    const { result, rerender } = renderHook(() => useDashboardPeriod());
    expect(result.current[0]).toBe('all');
    act(() => result.current[1]('ytd'));
    rerender();
    expect(result.current[0]).toBe('ytd');
    expect(localStorage.getItem(PERIOD_STORAGE_KEY)).toBe('ytd');
    expect(renderHook(() => useDashboardPeriod()).result.current[0]).toBe('ytd');
  });

  it('ignores an unknown stored value and unavailable storage', () => {
    localStorage.setItem(PERIOD_STORAGE_KEY, '3y');
    expect(readStoredPeriod()).toBe('all');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useDashboardPeriod());
    expect(result.current[0]).toBe('all');
    act(() => result.current[1]('5y'));
    expect(result.current[0]).toBe('5y');
  });

  it('leaves the all-time request unparameterised', () => {
    expect(queryPeriod('all')).toBeUndefined();
    expect(queryPeriod('ttm')).toBe('ttm');
  });

  it('names the period, or the real range when the history is shorter', () => {
    expect(coverageLabel('ttm', { truncated: false, from: '2025-10-16' })).toBe('Last 12 months');
    expect(coverageLabel('ytd', { truncated: false, from: '2026-01-01' })).toBe('Year to date');
    expect(coverageLabel('10y', { truncated: true, from: '2025-01-02' })).toBe(`Since ${formatDate('2025-01-02')}, the start of your history (shorter than the period)`);
    expect(coverageLabel('5y', { truncated: true, from: null })).toBe('Last 5 years');
  });
});
