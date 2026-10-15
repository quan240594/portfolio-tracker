/** MSW handlers of /goals: the saved goals live in memory and are projected with the shared calculators on the demo data. */
import { http, HttpResponse, type HttpHandler } from 'msw';
import {
  ALL_PORTFOLIOS,
  computeGoalProjection,
  defaultGoalSettings,
  goalScopeKey,
  goalSettingsSchemaFor,
  parseStoredGoal,
  portfolioScopeSchema,
  type GoalCalculateResponse,
  type GoalItem,
  type GoalResponse,
  type GoalSettings,
} from '@portfolio/shared';
import * as db from './db';
import { MOCK_USER_ID } from './fixtures';
import { MockHttpError, api, guard, latency } from './utils';

interface GoalStore {
  /** Identity of the demo seed the goals belong to: a reset of the demo data (new seed) also forgets the goals. */
  seed: unknown;
  goals: Map<string, GoalItem>;
}

let store: GoalStore = { seed: null, goals: new Map() };

function goals(): Map<string, GoalItem> {
  const seed = db.getSeed();
  if (store.seed !== seed) store = { seed, goals: new Map() };
  // A deleted portfolio takes its goal with it, like the API's cascade.
  const existing = new Set(db.listPortfolios().map((p) => p.portfolioId));
  for (const scope of store.goals.keys()) if (scope !== ALL_PORTFOLIOS && !existing.has(scope)) store.goals.delete(scope);
  return store.goals;
}

const today = (): string => db.getSeed().today;

/** Parses `?portfolioId=` like the API: omitted/`all` = combined; malformed → 400; unknown → 404. */
function scopeOf(request: Request): { scope: string; portfolioId: string | undefined } {
  const raw = new URL(request.url).searchParams.get('portfolioId') ?? undefined;
  const parsed = portfolioScopeSchema.safeParse({ portfolioId: raw });
  if (!parsed.success) throw new MockHttpError(400, 'VALIDATION_ERROR', 'Invalid query parameters', parsed.error.issues);
  const portfolioId = parsed.data.portfolioId === ALL_PORTFOLIOS ? undefined : parsed.data.portfolioId;
  if (portfolioId !== undefined) db.requirePortfolio(portfolioId);
  return { scope: goalScopeKey(portfolioId), portfolioId };
}

const project = (portfolioId: string | undefined, settings: GoalSettings) => computeGoalProjection(db.getAnalyticsData(portfolioId), settings);

async function settingsOf(request: Request): Promise<GoalSettings> {
  const parsed = goalSettingsSchemaFor(today()).safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw new MockHttpError(400, 'VALIDATION_ERROR', 'Invalid goal', parsed.error.issues);
  return parsed.data;
}

export const goalsHandlers: HttpHandler[] = [
  http.get(api('/goals'), async ({ request }) => {
    await latency();
    return guard(() => {
      const { scope, portfolioId } = scopeOf(request);
      const item = goals().get(scope);
      const settings = item ? parseStoredGoal(item, today()) : defaultGoalSettings(today());
      return HttpResponse.json<GoalResponse>({ saved: item !== undefined, updatedAt: item?.updatedAt ?? null, settings, projection: project(portfolioId, settings) });
    })();
  }),

  http.put(api('/goals'), async ({ request }) => {
    await latency();
    return guard(async () => {
      const { scope, portfolioId } = scopeOf(request);
      const settings = await settingsOf(request);
      const ts = new Date().toISOString();
      const existing = goals().get(scope);
      goals().set(scope, { ...settings, userId: MOCK_USER_ID, portfolioId: scope, createdAt: existing?.createdAt ?? ts, updatedAt: ts });
      return HttpResponse.json<GoalResponse>({ saved: true, updatedAt: ts, settings, projection: project(portfolioId, settings) });
    })();
  }),

  http.delete(api('/goals'), async ({ request }) => {
    await latency();
    return guard(() => {
      goals().delete(scopeOf(request).scope);
      return new HttpResponse(null, { status: 204 });
    })();
  }),

  http.post(api('/goals/calculate'), async ({ request }) => {
    await latency();
    return guard(async () => {
      const { portfolioId } = scopeOf(request);
      const settings = await settingsOf(request);
      return HttpResponse.json<GoalCalculateResponse>({ settings, projection: project(portfolioId, settings) });
    })();
  }),
];
