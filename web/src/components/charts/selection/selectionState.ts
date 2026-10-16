/** Pure helpers behind `useSeriesSelection`: the hidden keys live in immutable sets. */

/** A copy of `hidden` with `key` added when it was visible and removed when it was hidden. */
export function toggleKey(hidden: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(hidden);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** `hidden` without the keys that are not in `valid` any more; the same set when nothing was dropped (so state does not change needlessly). */
export function pruneKeys(hidden: ReadonlySet<string>, valid: ReadonlySet<string>): ReadonlySet<string> {
  const kept = [...hidden].filter((key) => valid.has(key));
  return kept.length === hidden.size ? hidden : new Set(kept);
}

/** True when `keys` is not empty and every key of it is hidden. */
export function allHidden(keys: readonly string[], hidden: ReadonlySet<string>): boolean {
  return keys.length > 0 && keys.every((key) => hidden.has(key));
}

/** The focused legend key, or null when nothing is focused or the key is excluded (an excluded entry is not drawn, so there is nothing to highlight). */
export function activeFocus(focus: string | null, hidden: ReadonlySet<string>): string | null {
  return focus !== null && !hidden.has(focus) ? focus : null;
}
