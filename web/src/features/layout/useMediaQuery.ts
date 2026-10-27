import { useCallback, useSyncExternalStore } from 'react';

/** The `md` breakpoint of the page grid: from here on the cards sit in 12 columns, below it in one. */
export const DESKTOP_QUERY = '(min-width: 768px)';

/** Whether the media query matches, kept up to date while the viewport changes; false where `matchMedia` does not exist. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = globalThis.matchMedia?.(query);
      list?.addEventListener('change', onChange);
      return () => list?.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => globalThis.matchMedia?.(query).matches ?? false,
    () => false,
  );
}
