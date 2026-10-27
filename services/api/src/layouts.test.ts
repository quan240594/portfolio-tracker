import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { MemoryItemStore } from '@portfolio/platform';
import { LAYOUT_PAGE_IDS, LAYOUT_ROUTES, MAX_LAYOUT_BODY_BYTES, type PageLayout, type PageLayoutItem } from '@portfolio/shared';
import { createHandler } from './lambda/handler.js';
import { matchRoute } from './router.js';
import { ItemManagementRepository } from './management-repository.js';
import type { Deps } from './deps.js';
import { apiEvent, fakeDeps } from './testing/fakes.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-06-15T12:00:00.000Z';

const json = (res: APIGatewayProxyStructuredResultV2) => (res.body ? JSON.parse(res.body) : undefined);

const desktop = (patch: Partial<PageLayout> = {}): PageLayout => ({ version: 1, breakpoint: 'desktop', order: ['b', 'a'], widths: { a: 'third' }, hidden: ['c'], ...patch });
const mobile = (patch: Partial<PageLayout> = {}): PageLayout => desktop({ breakpoint: 'mobile', widths: {}, ...patch });

function setup(authMode: 'cognito' | 'demo' = 'demo') {
  const ctx = fakeDeps();
  const deps: Deps = { ...ctx.deps, config: { ...ctx.deps.config, authMode } };
  const handler = createHandler(() => deps);
  const call = async (method: string, path: string, opts: { body?: unknown; sub?: string } = {}) => {
    const res = await handler(apiEvent(method, path, opts));
    return { status: res.statusCode, body: json(res) };
  };
  return { ...ctx, call };
}

describe('routing', () => {
  it('matches every layout route', () => {
    for (const [name, spec] of Object.entries(LAYOUT_ROUTES)) {
      const [method, path] = spec.split(' ') as [string, string];
      expect(matchRoute(method, path.replace('{page}', 'dashboard').replace('{breakpoint}', 'mobile')).name).toBe(name);
    }
  });
});

describe('GET /layouts/{page}', () => {
  it('answers nulls for a page that was never customised', async () => {
    expect(await setup().call('GET', '/layouts/dashboard')).toEqual({ status: 200, body: { desktop: null, mobile: null } });
  });

  it('answers the stored layouts without the identity of the item', async () => {
    const s = setup();
    expect((await s.call('PUT', '/layouts/dividends/desktop', { body: desktop() })).status).toBe(204);
    expect((await s.call('PUT', '/layouts/dividends/mobile', { body: mobile() })).status).toBe(204);
    expect(await s.call('GET', '/layouts/dividends')).toEqual({ status: 200, body: { desktop: desktop(), mobile: mobile() } });
    expect(await s.call('GET', '/layouts/holdings')).toEqual({ status: 200, body: { desktop: null, mobile: null } });
  });

  it('never serves a damaged item', async () => {
    const s = setup();
    s.mgmt.layouts.push({ userId: 'demo', page: 'goals', updatedAt: NOW, ...desktop(), order: 'oops' } as unknown as PageLayoutItem);
    expect((await s.call('GET', '/layouts/goals')).body).toEqual({ desktop: null, mobile: null });
  });

  it.each(['nope', 'Dashboard', 'asset%2Ddetail%2F'])('refuses the unknown page %s', async (page) => {
    const res = await setup().call('GET', `/layouts/${page}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts every declared page', async () => {
    const s = setup();
    for (const page of LAYOUT_PAGE_IDS) expect((await s.call('GET', `/layouts/${page}`)).status).toBe(200);
  });
});

describe('PUT /layouts/{page}/{breakpoint}', () => {
  it('stores the layout with the identity from the request, not the body', async () => {
    const s = setup();
    const res = await s.call('PUT', '/layouts/dashboard/desktop', { body: desktop() });
    expect(res).toEqual({ status: 204, body: undefined });
    expect(s.mgmt.layouts).toEqual([{ ...desktop(), userId: 'demo', page: 'dashboard', updatedAt: NOW }]);
  });

  it('replaces the stored layout of the same page and breakpoint only', async () => {
    const s = setup();
    await s.call('PUT', '/layouts/dashboard/desktop', { body: desktop() });
    await s.call('PUT', '/layouts/dashboard/mobile', { body: mobile() });
    await s.call('PUT', '/layouts/dashboard/desktop', { body: desktop({ order: ['x'], hidden: [] }) });
    expect(s.mgmt.layouts).toHaveLength(2);
    expect((await s.call('GET', '/layouts/dashboard')).body).toEqual({ desktop: desktop({ order: ['x'], hidden: [] }), mobile: mobile() });
  });

  it('clears the breakpoint for a null body and for a layout without overrides', async () => {
    const s = setup();
    await s.call('PUT', '/layouts/dashboard/desktop', { body: desktop() });
    await s.call('PUT', '/layouts/dashboard/mobile', { body: mobile() });
    expect((await s.call('PUT', '/layouts/dashboard/desktop', { body: 'null' })).status).toBe(204);
    expect((await s.call('GET', '/layouts/dashboard')).body).toEqual({ desktop: null, mobile: mobile() });
    expect((await s.call('PUT', '/layouts/dashboard/mobile', { body: desktop({ breakpoint: 'mobile', order: [], widths: {}, hidden: [] }) })).status).toBe(204);
    expect((await s.call('GET', '/layouts/dashboard')).body).toEqual({ desktop: null, mobile: null });
    expect((await s.call('PUT', '/layouts/dashboard/desktop', { body: 'null' })).status).toBe(204);
  });

  it.each([
    ['a missing body', undefined],
    ['text that is not JSON', 'not json'],
    ['an empty object', {}],
    ['another version', desktop({ version: 2 as 1 })],
    ['an invalid card id', desktop({ order: ['Not Valid'] })],
    ['a duplicate card id', desktop({ hidden: ['a', 'a'] })],
    ['an unknown width', desktop({ widths: { a: 'quarter' as 'full' } })],
    ['an extra property', { ...desktop(), userId: 'someone-else' }],
    ['a layout of the other breakpoint', mobile()],
  ])('refuses %s with 400 and stores nothing', async (_label, body) => {
    const s = setup();
    const res = await s.call('PUT', '/layouts/dashboard/desktop', { body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(s.mgmt.layouts).toEqual([]);
  });

  it('refuses an unknown page or breakpoint', async () => {
    const s = setup();
    expect((await s.call('PUT', '/layouts/nope/desktop', { body: desktop() })).status).toBe(400);
    const tablet = await s.call('PUT', '/layouts/dashboard/tablet', { body: desktop() });
    expect(tablet.status).toBe(400);
    expect(tablet.body.error.message).toContain('tablet');
    expect(s.mgmt.layouts).toEqual([]);
  });

  it('refuses a body above the size limit with 413', async () => {
    const s = setup();
    const huge = `{"version":1,"breakpoint":"desktop","order":[],"widths":{},"hidden":[],"pad":"${'x'.repeat(MAX_LAYOUT_BODY_BYTES)}"}`;
    const res = await s.call('PUT', '/layouts/dashboard/desktop', { body: huge });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('DELETE /layouts/{page}', () => {
  it('clears both breakpoints of the page and leaves the other pages alone', async () => {
    const s = setup();
    await s.call('PUT', '/layouts/dashboard/desktop', { body: desktop() });
    await s.call('PUT', '/layouts/dashboard/mobile', { body: mobile() });
    await s.call('PUT', '/layouts/holdings/desktop', { body: desktop() });
    expect((await s.call('DELETE', '/layouts/dashboard')).status).toBe(204);
    expect((await s.call('GET', '/layouts/dashboard')).body).toEqual({ desktop: null, mobile: null });
    expect((await s.call('GET', '/layouts/holdings')).body.desktop).toEqual(desktop());
    expect((await s.call('DELETE', '/layouts/dashboard')).status).toBe(204);
  });

  it('refuses an unknown page', async () => {
    expect((await setup().call('DELETE', '/layouts/nope')).status).toBe(400);
  });
});

describe('authentication and isolation', () => {
  it('answers 401 without a signed-in user, for every layout route', async () => {
    const s = setup('cognito');
    for (const [method, path] of [
      ['GET', '/layouts/dashboard'],
      ['PUT', '/layouts/dashboard/desktop'],
      ['DELETE', '/layouts/dashboard'],
    ] as const) {
      const res = await s.call(method, path, { body: desktop() });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(s.mgmt.layouts).toEqual([]);
  });

  it('keeps the layouts of every user apart', async () => {
    const s = setup('cognito');
    expect((await s.call('PUT', '/layouts/dashboard/desktop', { body: desktop(), sub: ALICE })).status).toBe(204);
    expect((await s.call('GET', '/layouts/dashboard', { sub: BOB })).body).toEqual({ desktop: null, mobile: null });
    expect((await s.call('DELETE', '/layouts/dashboard', { sub: BOB })).status).toBe(204);
    expect((await s.call('GET', '/layouts/dashboard', { sub: ALICE })).body.desktop).toEqual(desktop());
  });
});

describe('GET /export/backup', () => {
  it('includes the layouts', async () => {
    const s = setup();
    await s.call('PUT', '/layouts/dashboard/desktop', { body: desktop() });
    const backup = await s.call('GET', '/export/backup');
    expect(backup.body.layouts).toEqual([{ ...desktop(), userId: 'demo', page: 'dashboard', updatedAt: NOW }]);
  });
});

describe('ItemManagementRepository layouts', () => {
  const item = (patch: Partial<PageLayoutItem> = {}): PageLayoutItem => ({ ...desktop(), userId: 'u1', page: 'dashboard', updatedAt: NOW, ...patch });

  it('stores one item per user, page and breakpoint under LAYOUT#', async () => {
    const store = new MemoryItemStore();
    const repo = new ItemManagementRepository(store);
    await repo.putLayout(item());
    await repo.putLayout(item({ ...mobile(), page: 'dashboard' }));
    await repo.putLayout(item({ page: 'goals' }));
    await repo.putLayout(item({ userId: 'u2' }));
    expect(store.snapshot().map((i) => [i.PK, i.SK, i.entityType])).toEqual([
      ['USER#u1', 'LAYOUT#dashboard#desktop', 'LAYOUT'],
      ['USER#u1', 'LAYOUT#dashboard#mobile', 'LAYOUT'],
      ['USER#u1', 'LAYOUT#goals#desktop', 'LAYOUT'],
      ['USER#u2', 'LAYOUT#dashboard#desktop', 'LAYOUT'],
    ]);
    expect((await repo.getLayouts('u1', 'dashboard')).map((i) => i.breakpoint).sort((a, b) => a.localeCompare(b))).toEqual(['desktop', 'mobile']);
    expect(await repo.getLayouts('u1', 'holdings')).toEqual([]);
    expect(await repo.listLayouts('u1')).toHaveLength(3);
    expect(await repo.listLayouts('u3')).toEqual([]);
    await repo.deleteLayout('u1', 'dashboard', 'desktop');
    await repo.deleteLayout('u1', 'dashboard', 'desktop');
    expect((await repo.listLayouts('u1')).map((i) => `${i.page}/${i.breakpoint}`)).toEqual(['dashboard/mobile', 'goals/desktop']);
    expect(await repo.getLayouts('u1', 'goals')).toEqual([item({ page: 'goals' })]);
  });
});
