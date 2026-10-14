function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

export const API_BASE_URL: string = trimTrailingSlashes(import.meta.env.VITE_API_BASE_URL || '/api');

export const USE_MOCKS: boolean =
  import.meta.env.VITE_USE_MOCKS === 'true' || import.meta.env.MODE === 'mock';

/**
 * React Router basename derived from Vite's `BASE_URL` (set via `VITE_BASE_PATH`):
 * "/portfolio-tracker/" → "/portfolio-tracker", "/" (or a relative base) → undefined.
 */
export function routerBasename(baseUrl: string = import.meta.env.BASE_URL): string | undefined {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : undefined;
}
