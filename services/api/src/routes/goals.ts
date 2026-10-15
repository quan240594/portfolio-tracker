import {
  computeGoalProjection,
  defaultGoalSettings,
  goalScopeKey,
  goalSettingsSchemaFor,
  parseStoredGoal,
  type GOALS_ROUTES,
  type GoalCalculateResponse,
  type GoalItem,
  type GoalResponse,
  type GoalSettings,
} from '@portfolio/shared';
import { ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import type { RouteHandler } from '../router.js';
import { loadAnalyticsData } from './analytics.js';
import { resolveScope } from './portfolios.js';

const today = (ctx: RouteContext): string => ctx.deps.now().toISOString().slice(0, 10);

/** Today's projection of the scope's current holdings (the scope itself is validated by the data loader). */
async function project(ctx: RouteContext, settings: GoalSettings) {
  const data = await loadAnalyticsData(ctx, { holdings: true, events: true });
  return computeGoalProjection(data, settings);
}

function requestSettings(ctx: RouteContext): GoalSettings {
  return validate(goalSettingsSchemaFor(today(ctx)).safeParse(parseJsonBody(ctx.body, ctx.isBase64Encoded)), 'Invalid goal');
}

export async function getGoal(ctx: RouteContext): Promise<RouteResult> {
  const scope = goalScopeKey(await resolveScope(ctx));
  const item = await ctx.deps.mgmt.getGoal(ctx.userId, scope);
  const settings = item ? parseStoredGoal(item, today(ctx)) : defaultGoalSettings(today(ctx));
  return ok({ saved: item !== null, updatedAt: item?.updatedAt ?? null, settings, projection: await project(ctx, settings) } satisfies GoalResponse);
}

export async function putGoal(ctx: RouteContext): Promise<RouteResult> {
  const scope = goalScopeKey(await resolveScope(ctx));
  const settings = requestSettings(ctx);
  const { mgmt, now } = ctx.deps;
  const existing = await mgmt.getGoal(ctx.userId, scope);
  const ts = now().toISOString();
  // Identity comes from the authenticated context and the validated scope only, never from the body.
  const item: GoalItem = { ...settings, userId: ctx.userId, portfolioId: scope, createdAt: existing?.createdAt ?? ts, updatedAt: ts };
  await mgmt.putGoal(item);
  return ok({ saved: true, updatedAt: ts, settings, projection: await project(ctx, settings) } satisfies GoalResponse);
}

export async function deleteGoal(ctx: RouteContext): Promise<RouteResult> {
  await ctx.deps.mgmt.deleteGoal(ctx.userId, goalScopeKey(await resolveScope(ctx)));
  return ok(undefined, 204);
}

export async function calculateGoal(ctx: RouteContext): Promise<RouteResult> {
  const settings = requestSettings(ctx);
  return ok({ settings, projection: await project(ctx, settings) } satisfies GoalCalculateResponse);
}

export const goalsHandlers: Record<keyof typeof GOALS_ROUTES, RouteHandler> = {
  goalsGet: getGoal,
  goalsPut: putGoal,
  goalsDelete: deleteGoal,
  goalsCalculate: calculateGoal,
};
