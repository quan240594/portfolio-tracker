import { useCallback, useState } from 'react';

export const DISMISSED_INSIGHTS_KEY = 'pt-dismissed-insights';

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(DISMISSED_INSIGHTS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function write(ids: readonly string[]) {
  try {
    sessionStorage.setItem(DISMISSED_INSIGHTS_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable: dismissals then only last until the page is left.
  }
}

/**
 * Insights the user dismissed during this browser session, keyed by `${scope}:${insightId}` so a dismissal in
 * one portfolio does not hide the same insight in another.
 */
export function useDismissedInsights() {
  const [dismissed, setDismissed] = useState<string[]>(read);

  const update = useCallback((next: string[]) => {
    write(next);
    setDismissed(next);
  }, []);

  const dismiss = useCallback((key: string) => update([...new Set([...read(), key])]), [update]);
  const restore = useCallback((keys: readonly string[]) => update(read().filter((k) => !keys.includes(k))), [update]);

  return { dismissed, dismiss, restore };
}
