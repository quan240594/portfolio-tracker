import {
  LAYOUT_BREAKPOINTS,
  MAX_LAYOUT_BODY_BYTES,
  isLayoutPageId,
  layoutOfItem,
  layoutPutSchema,
  type LAYOUT_ROUTES,
  type LayoutBreakpoint,
  type LayoutPageId,
  type PageLayout,
  type PageLayoutItem,
  type PageLayoutsResponse,
} from '@portfolio/shared';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import type { RouteHandler } from '../router.js';

const BYTES = new TextEncoder();

function pagePath(ctx: RouteContext): LayoutPageId {
  const page = ctx.pathParams.page!;
  if (!isLayoutPageId(page)) throw new HttpError(400, 'VALIDATION_ERROR', `Unknown page "${page}"`);
  return page;
}

function breakpointPath(ctx: RouteContext): LayoutBreakpoint {
  const breakpoint = LAYOUT_BREAKPOINTS.find((candidate) => candidate === ctx.pathParams.breakpoint);
  if (breakpoint === undefined) throw new HttpError(400, 'VALIDATION_ERROR', `Unknown breakpoint "${ctx.pathParams.breakpoint}"`);
  return breakpoint;
}

const isEmpty = (layout: PageLayout): boolean => layout.order.length === 0 && layout.hidden.length === 0 && Object.keys(layout.widths).length === 0;

export async function getLayouts(ctx: RouteContext): Promise<RouteResult> {
  const items = await ctx.deps.mgmt.getLayouts(ctx.userId, pagePath(ctx));
  const layoutOf = (breakpoint: LayoutBreakpoint): PageLayout | null => {
    const item = items.find((candidate) => candidate.breakpoint === breakpoint);
    return item ? layoutOfItem(item) : null;
  };
  return ok({ desktop: layoutOf('desktop'), mobile: layoutOf('mobile') } satisfies PageLayoutsResponse);
}

export async function putLayout(ctx: RouteContext): Promise<RouteResult> {
  const page = pagePath(ctx);
  const breakpoint = breakpointPath(ctx);
  if (ctx.body !== undefined && BYTES.encode(ctx.body).byteLength > MAX_LAYOUT_BODY_BYTES) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `A layout is at most ${MAX_LAYOUT_BODY_BYTES} bytes`);
  }
  const layout = validate(layoutPutSchema.safeParse(parseJsonBody(ctx.body)), 'Invalid layout');
  const { mgmt, now } = ctx.deps;
  if (layout === null || isEmpty(layout)) {
    await mgmt.deleteLayout(ctx.userId, page, breakpoint);
    return ok(undefined, 204);
  }
  if (layout.breakpoint !== breakpoint) throw new HttpError(400, 'VALIDATION_ERROR', `The layout is for "${layout.breakpoint}", not "${breakpoint}"`);
  // Identity comes from the authenticated context and the validated path only, never from the body.
  const item: PageLayoutItem = { ...layout, userId: ctx.userId, page, updatedAt: now().toISOString() };
  await mgmt.putLayout(item);
  return ok(undefined, 204);
}

export async function deleteLayouts(ctx: RouteContext): Promise<RouteResult> {
  const page = pagePath(ctx);
  await Promise.all(LAYOUT_BREAKPOINTS.map((breakpoint) => ctx.deps.mgmt.deleteLayout(ctx.userId, page, breakpoint)));
  return ok(undefined, 204);
}

export const layoutsHandlers: Record<keyof typeof LAYOUT_ROUTES, RouteHandler> = {
  layoutsGet: getLayouts,
  layoutsPut: putLayout,
  layoutsDelete: deleteLayouts,
};
