import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { createTestQueryClient } from '../../test/utils';
import { BLOCKED_SNAPSHOT, OK_SNAPSHOT, serveUsage, UNAVAILABLE_SNAPSHOT, WARN_SNAPSHOT } from '../../test/usage';
import { setAuthTokenHooks } from '../auth/tokenHooks';
import { USAGE_POLL_MS, USAGE_QUERY_KEY, USAGE_STALE_MS, useUsage } from './useUsage';

const mocks = vi.hoisted(() => ({ useMocks: false }));
vi.mock('../../config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config')>()),
  get USE_MOCKS() {
    return mocks.useMocks;
  },
}));

function setup() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, ...renderHook(() => useUsage(), { wrapper }) };
}

type Interval = (query: unknown) => number | false;
type Stale = (query: unknown) => number;
const options = (queryClient: ReturnType<typeof setup>['queryClient']) => {
  const query = queryClient.getQueryCache().find({ queryKey: USAGE_QUERY_KEY })!;
  return { query, ...(query.options as unknown as { refetchInterval: Interval; staleTime: Stale; refetchOnWindowFocus: boolean; refetchIntervalInBackground?: boolean }) };
};

afterEach(() => {
  mocks.useMocks = false;
  vi.useRealTimers();
  setAuthTokenHooks(undefined);
});

describe('useUsage states', () => {
  it.each([
    ['ok', OK_SNAPSHOT],
    ['warn', WARN_SNAPSHOT],
    ['blocked', BLOCKED_SNAPSHOT],
    ['unavailable', UNAVAILABLE_SNAPSHOT],
  ] as const)('exposes a validated %s snapshot', async (state, snapshot) => {
    serveUsage(snapshot);
    const { result } = setup();
    expect(result.current).toEqual({ availability: 'loading' });
    await waitFor(() => expect(result.current.availability).toBe('ready'));
    expect(result.current.snapshot).toEqual(snapshot);
    expect(result.current.snapshot?.state).toBe(state);
  });

  it.each([404, 405, 403])('treats status %i as "not exposed" without any error', async (status) => {
    server.use(http.get(api('/usage'), () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status })));
    const { result } = setup();
    await waitFor(() => expect(result.current.availability).toBe('not-exposed'));
    expect(result.current.snapshot).toBeUndefined();
  });

  it('treats a 401 as "not exposed" and does not sign the user out', async () => {
    const onUnauthorized = vi.fn();
    setAuthTokenHooks({ getToken: () => Promise.resolve(undefined), onUnauthorized });
    server.use(http.get(api('/usage'), () => HttpResponse.json({ message: 'Unauthorized' }, { status: 401 })));
    const { result } = setup();
    await waitFor(() => expect(result.current.availability).toBe('not-exposed'));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('treats an HTML answer (a static host falling back to index.html) or a foreign JSON body as "not exposed"', async () => {
    server.use(http.get(api('/usage'), () => new HttpResponse('<!doctype html><title>app</title>', { headers: { 'Content-Type': 'text/html' } })));
    const html = setup();
    await waitFor(() => expect(html.result.current.availability).toBe('not-exposed'));

    server.use(http.get(api('/usage'), () => HttpResponse.json({ state: 'ok' })));
    const json = setup();
    await waitFor(() => expect(json.result.current.availability).toBe('not-exposed'));
  });

  it.each([
    ['a network error', () => HttpResponse.error()],
    ['a server error', () => new HttpResponse('boom', { status: 500 })],
  ])('is "unreachable" after %s, not an error to show', async (_name, resolver) => {
    server.use(http.get(api('/usage'), resolver));
    const { result } = setup();
    await waitFor(() => expect(result.current.availability).toBe('unreachable'));
    expect(result.current.snapshot).toBeUndefined();
  });

  it('keeps the last reading when a refresh fails', async () => {
    serveUsage(WARN_SNAPSHOT);
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.availability).toBe('ready'));
    server.use(http.get(api('/usage'), () => HttpResponse.error()));
    await act(() => queryClient.refetchQueries({ queryKey: USAGE_QUERY_KEY }));
    expect(result.current).toEqual({ availability: 'ready', snapshot: WARN_SNAPSHOT });
  });

  it('never asks in mock mode (the public demo)', () => {
    mocks.useMocks = true;
    const usage = serveUsage(OK_SNAPSHOT);
    const { result } = setup();
    expect(result.current).toEqual({ availability: 'not-exposed' });
    expect(usage.calls()).toBe(0);
  });
});

describe('useUsage polling', () => {
  it('polls every five minutes, not in a hidden tab, and refetches on window focus', async () => {
    serveUsage(OK_SNAPSHOT);
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.availability).toBe('ready'));
    const { query, refetchInterval, staleTime, refetchOnWindowFocus, refetchIntervalInBackground } = options(queryClient);
    expect(USAGE_POLL_MS).toBe(300_000);
    expect(refetchInterval(query)).toBe(USAGE_POLL_MS);
    expect(staleTime(query)).toBe(USAGE_STALE_MS);
    expect(refetchOnWindowFocus).toBe(true);
    expect(refetchIntervalInBackground).toBeFalsy();
  });

  it('refetches on focus once the reading is stale, but not while it is fresh', async () => {
    const usage = serveUsage(OK_SNAPSHOT);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-19T10:00:00Z') });
    const { result } = setup();
    await waitFor(() => expect(result.current.availability).toBe('ready'));
    expect(usage.calls()).toBe(1);

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(usage.calls()).toBe(1);

    vi.setSystemTime(Date.parse('2026-10-19T10:02:00Z'));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(usage.calls()).toBe(2));
  });

  it('stops polling and never refetches once the backend turned out not to expose usage', async () => {
    server.use(http.get(api('/usage'), () => new HttpResponse(null, { status: 404 })));
    const { result, queryClient } = setup();
    await waitFor(() => expect(result.current.availability).toBe('not-exposed'));
    const { query, refetchInterval, staleTime } = options(queryClient);
    expect(refetchInterval(query)).toBe(false);
    expect(staleTime(query)).toBe(Infinity);
  });
});
