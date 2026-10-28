import { createContext, useContext, type ReactNode } from 'react';
import { LAYOUT_BREAKPOINTS, pageLayoutSchema, type LayoutBreakpoint, type LayoutPageId, type PageLayout, type PageLayoutsResponse } from '@portfolio/shared';
import { ApiError, request } from '../../api/client';
import { USE_MOCKS } from '../../config';

/** Where the layouts of a page live: the account (API) or, in the public demo, this browser. */
export interface LayoutStore {
  /** What this browser last knew about the page, available at once (no request); null when nothing is stored. */
  cached(page: LayoutPageId): PageLayoutsResponse | null;
  load(page: LayoutPageId, signal?: AbortSignal): Promise<PageLayoutsResponse>;
  /** Stores one breakpoint's layout; null clears it. */
  save(page: LayoutPageId, breakpoint: LayoutBreakpoint, layout: PageLayout | null): Promise<void>;
}

const storageKey = (page: LayoutPageId, breakpoint: LayoutBreakpoint): string => `portfolio-tracker.layout.${page}.${breakpoint}`;

/** A stored layout of this browser; anything unreadable or of the wrong breakpoint counts as none. */
function readLocal(page: LayoutPageId, breakpoint: LayoutBreakpoint): PageLayout | null {
  try {
    const raw = globalThis.localStorage.getItem(storageKey(page, breakpoint));
    if (raw === null) return null;
    const parsed = pageLayoutSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.breakpoint === breakpoint ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Throws when the browser refuses to store (private mode, quota). */
function writeLocal(page: LayoutPageId, breakpoint: LayoutBreakpoint, layout: PageLayout | null): void {
  if (layout === null) globalThis.localStorage.removeItem(storageKey(page, breakpoint));
  else globalThis.localStorage.setItem(storageKey(page, breakpoint), JSON.stringify(layout));
}

function readLocalPage(page: LayoutPageId): PageLayoutsResponse | null {
  const [desktop, mobile] = LAYOUT_BREAKPOINTS.map((breakpoint) => readLocal(page, breakpoint));
  return desktop === null && mobile === null ? null : { desktop: desktop!, mobile: mobile! };
}

function rememberLocally(page: LayoutPageId, breakpoint: LayoutBreakpoint, layout: PageLayout | null): void {
  try {
    writeLocal(page, breakpoint, layout);
  } catch {
    // Only a cache of the account's layout: nothing is lost when the browser refuses it.
  }
}

/** Layouts kept in localStorage only: the demo, which has no account. */
export const localLayoutStore: LayoutStore = {
  cached: readLocalPage,
  load: (page) => Promise.resolve(readLocalPage(page) ?? { desktop: null, mobile: null }),
  save(page, breakpoint, layout) {
    try {
      writeLocal(page, breakpoint, layout);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Could not store the layout in this browser'));
    }
  },
};

/** A deployment that predates the layouts API answers 404 (or 405/501): the layouts then live in this browser only. */
const isRouteMissing = (error: unknown): boolean => error instanceof ApiError && [404, 405, 501].includes(error.status);

/** Layouts kept in the user's account; this browser keeps a copy so a revisit shows the saved layout without waiting. */
export const apiLayoutStore: LayoutStore = {
  cached: readLocalPage,
  async load(page, signal) {
    try {
      const layouts = await request<PageLayoutsResponse>('GET', `/layouts/${page}`, { signal });
      for (const breakpoint of LAYOUT_BREAKPOINTS) rememberLocally(page, breakpoint, layouts[breakpoint]);
      return layouts;
    } catch (error) {
      if (!isRouteMissing(error)) throw error;
      return readLocalPage(page) ?? { desktop: null, mobile: null };
    }
  },
  async save(page, breakpoint, layout) {
    try {
      await request<void>('PUT', `/layouts/${page}/${breakpoint}`, { body: layout });
    } catch (error) {
      if (!isRouteMissing(error)) throw error;
    }
    rememberLocally(page, breakpoint, layout);
  },
};

export const defaultLayoutStore = (useMocks: boolean): LayoutStore => (useMocks ? localLayoutStore : apiLayoutStore);

const LayoutStoreContext = createContext<LayoutStore>(defaultLayoutStore(USE_MOCKS));

/** Replaces the store of everything below (tests, the e2e page); the app itself needs none. */
export function LayoutStoreProvider({ store, children }: Readonly<{ store: LayoutStore; children: ReactNode }>) {
  return <LayoutStoreContext.Provider value={store}>{children}</LayoutStoreContext.Provider>;
}

export const useLayoutStore = (): LayoutStore => useContext(LayoutStoreContext);
