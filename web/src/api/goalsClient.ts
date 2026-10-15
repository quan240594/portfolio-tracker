import type { GoalCalculateResponse, GoalResponse, GoalSettings } from '@portfolio/shared';
import { request, scopeQuery } from './client';

export const goalsApi = {
  get: (scope: string, signal?: AbortSignal) => request<GoalResponse>('GET', '/goals', { query: scopeQuery(scope), signal }),
  save: (scope: string, settings: GoalSettings) => request<GoalResponse>('PUT', '/goals', { query: scopeQuery(scope), body: settings }),
  reset: (scope: string) => request<void>('DELETE', '/goals', { query: scopeQuery(scope) }),
  calculate: (scope: string, settings: GoalSettings, signal?: AbortSignal) =>
    request<GoalCalculateResponse>('POST', '/goals/calculate', { query: scopeQuery(scope), body: settings, signal }),
};
