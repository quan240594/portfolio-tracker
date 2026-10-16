function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

export const API_BASE_URL: string = trimTrailingSlashes(import.meta.env.VITE_API_BASE_URL || '/api');

export const USE_MOCKS: boolean =
  import.meta.env.VITE_USE_MOCKS === 'true' || import.meta.env.MODE === 'mock';

/** Accepts only a credential-free https URL; anything else (http, javascript:, garbage, empty) yields undefined. */
export function parseRealAppUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Address of the user's own deployed app (build-time `VITE_REAL_APP_URL`); the demo banner links there when valid. */
export const REAL_APP_URL: string | undefined = parseRealAppUrl(import.meta.env.VITE_REAL_APP_URL);

/**
 * React Router basename derived from Vite's `BASE_URL` (set via `VITE_BASE_PATH`):
 * "/portfolio-tracker/" → "/portfolio-tracker", "/" (or a relative base) → undefined.
 */
export function routerBasename(baseUrl: string = import.meta.env.BASE_URL): string | undefined {
  const trimmed = trimTrailingSlashes(baseUrl);
  return trimmed.startsWith('/') ? trimmed : undefined;
}
