export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');

export const USE_MOCKS: boolean =
  import.meta.env.VITE_USE_MOCKS === 'true' || import.meta.env.MODE === 'mock';
