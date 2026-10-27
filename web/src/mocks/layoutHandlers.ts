/** MSW handlers of /layouts: the stored page layouts live in memory, like the API (empty body or `null` clears a breakpoint). */
import { http, HttpResponse, type HttpHandler } from 'msw';
import { LAYOUT_BREAKPOINTS, isLayoutPageId, layoutPutSchema, type PageLayout, type PageLayoutsResponse } from '@portfolio/shared';
import * as db from './db';
import { api, errorResponse } from './utils';

interface LayoutStore {
  seed: unknown;
  layouts: Map<string, PageLayout>;
}

let store: LayoutStore = { seed: null, layouts: new Map() };

/** A reset of the demo data (new seed) also forgets the layouts. */
function layouts(): Map<string, PageLayout> {
  const seed = db.getSeed();
  if (store.seed !== seed) store = { seed, layouts: new Map() };
  return store.layouts;
}

const keyOf = (page: string, breakpoint: string): string => `${page}#${breakpoint}`;

export const layoutHandlers: HttpHandler[] = [
  http.get(api('/layouts/:page'), ({ params }) => {
    const page = String(params.page);
    if (!isLayoutPageId(page)) return errorResponse(400, 'VALIDATION_ERROR', `Unknown page "${page}"`);
    const [desktop, mobile] = LAYOUT_BREAKPOINTS.map((breakpoint) => layouts().get(keyOf(page, breakpoint)) ?? null);
    return HttpResponse.json<PageLayoutsResponse>({ desktop: desktop!, mobile: mobile! });
  }),

  http.put(api('/layouts/:page/:breakpoint'), async ({ params, request }) => {
    const page = String(params.page);
    const breakpoint = String(params.breakpoint);
    if (!isLayoutPageId(page) || !LAYOUT_BREAKPOINTS.some((candidate) => candidate === breakpoint)) {
      return errorResponse(400, 'VALIDATION_ERROR', 'Unknown page or breakpoint');
    }
    const parsed = layoutPutSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return errorResponse(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid layout');
    if (parsed.data === null) layouts().delete(keyOf(page, breakpoint));
    else layouts().set(keyOf(page, breakpoint), parsed.data);
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete(api('/layouts/:page'), ({ params }) => {
    const page = String(params.page);
    if (!isLayoutPageId(page)) return errorResponse(400, 'VALIDATION_ERROR', `Unknown page "${page}"`);
    for (const breakpoint of LAYOUT_BREAKPOINTS) layouts().delete(keyOf(page, breakpoint));
    return new HttpResponse(null, { status: 204 });
  }),
];
