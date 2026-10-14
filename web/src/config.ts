function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

export const API_BASE_URL: string = trimTrailingSlashes(import.meta.env.VITE_API_BASE_URL || '/api');

export const USE_MOCKS: boolean =
  import.meta.env.VITE_USE_MOCKS === 'true' || import.meta.env.MODE === 'mock';
