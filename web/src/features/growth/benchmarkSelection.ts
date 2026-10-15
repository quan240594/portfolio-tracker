import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DEFAULT_BENCHMARK, parseBenchmarkList } from '@portfolio/shared';

/** URL search param (and sessionStorage key) holding the selected benchmarks, comma separated; empty = none. */
export const BENCHMARKS_PARAM = 'benchmarks';
export const BENCHMARKS_STORAGE_KEY = 'pt-growth-benchmarks';
export const DEFAULT_BENCHMARKS: readonly string[] = [DEFAULT_BENCHMARK];

export function readStoredBenchmarks(): string[] | null {
  try {
    const raw = sessionStorage.getItem(BENCHMARKS_STORAGE_KEY);
    return raw === null ? null : parseBenchmarkList(raw);
  } catch {
    return null;
  }
}

function storeBenchmarks(benchmarks: readonly string[]) {
  try {
    sessionStorage.setItem(BENCHMARKS_STORAGE_KEY, benchmarks.join(','));
  } catch {
    // Storage unavailable: the URL still carries the selection.
  }
}

/**
 * Selected benchmarks (at most three). The URL (`?benchmarks=`) is the source of truth; without it the choice of this
 * browser session is used, then the default benchmark. An invalid URL value is ignored.
 */
export function useBenchmarkSelection() {
  const [params, setParams] = useSearchParams();
  const raw = params.get(BENCHMARKS_PARAM);
  const fromUrl = raw === null ? null : parseBenchmarkList(raw);
  const key = (fromUrl ?? readStoredBenchmarks() ?? DEFAULT_BENCHMARKS).join(',');
  const benchmarks = useMemo(() => (key === '' ? [] : key.split(',')), [key]);

  const setBenchmarks = useCallback(
    (next: readonly string[]) => {
      storeBenchmarks(next);
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          n.set(BENCHMARKS_PARAM, next.join(','));
          return n;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return { benchmarks, setBenchmarks };
}
