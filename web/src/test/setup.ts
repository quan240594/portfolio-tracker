import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { server } from '../mocks/server';
import { resetDb } from '../mocks/db';

// Recharts' ResponsiveContainer needs ResizeObserver; jsdom has none.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom's Blob has no text(); delegate to FileReader so code under test can use the standard API.
Blob.prototype.text ??= function text(this: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(this);
  });
};

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Async queries (findBy*/waitFor) get extra headroom for slow, contended CI runners.
configure({ asyncUtilTimeout: 3000 });

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetDb();
  localStorage.clear();
  sessionStorage.clear();
});
afterAll(() => server.close());
