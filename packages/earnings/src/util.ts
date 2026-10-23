/** A copy of `value` without `undefined` properties (stores keep JSON: an absent field is absent, not `undefined`). */
export function dropUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => dropUndefined(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, dropUndefined(entry)]),
    ) as T;
  }
  return value;
}

/** `2026-10-21` plus `days` days (negative for earlier), as an ISO date. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export const utcDayOf = (now: Date): string => now.toISOString().slice(0, 10);
