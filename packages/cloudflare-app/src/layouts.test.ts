import { describe, expect, it } from 'vitest';
import { Browser } from '../test/browser.js';
import { createNodeStack } from '../test/node-stack.js';

const LAYOUT = { version: 1, breakpoint: 'desktop', order: ['b', 'a'], widths: { a: 'half' }, hidden: ['c'] };

async function signedIn() {
  const stack = await createNodeStack();
  const owner = new Browser(stack);
  await owner.signIn();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await owner.request(`/api${path}`, { method, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  return { api };
}

describe('page layouts on the Hub storage', () => {
  it('stores, serves and clears the owner’s layouts in the Durable Object SQLite items', async () => {
    const { api } = await signedIn();
    expect((await api('GET', '/layouts/dashboard')).body).toEqual({ desktop: null, mobile: null });

    expect((await api('PUT', '/layouts/dashboard/desktop', LAYOUT)).status).toBe(204);
    expect((await api('PUT', '/layouts/dashboard/mobile', { ...LAYOUT, breakpoint: 'mobile' })).status).toBe(204);
    expect((await api('GET', '/layouts/dashboard')).body).toEqual({ desktop: LAYOUT, mobile: { ...LAYOUT, breakpoint: 'mobile' } });
    expect((await api('GET', '/layouts/goals')).body).toEqual({ desktop: null, mobile: null });

    expect((await api('PUT', '/layouts/dashboard/desktop', null)).status).toBe(204);
    expect((await api('GET', '/layouts/dashboard')).body).toEqual({ desktop: null, mobile: { ...LAYOUT, breakpoint: 'mobile' } });

    expect((await api('DELETE', '/layouts/dashboard')).status).toBe(204);
    expect((await api('GET', '/layouts/dashboard')).body).toEqual({ desktop: null, mobile: null });
  });

  it('refuses unknown pages, mismatching breakpoints and oversized or invalid bodies', async () => {
    const { api } = await signedIn();
    expect((await api('GET', '/layouts/nope')).status).toBe(400);
    expect((await api('PUT', '/layouts/dashboard/mobile', LAYOUT)).status).toBe(400);
    expect((await api('PUT', '/layouts/dashboard/desktop', { ...LAYOUT, extra: true })).status).toBe(400);
    const huge = { ...LAYOUT, order: Array.from({ length: 1000 }, (_, index) => `card-${index}`) };
    expect((await api('PUT', '/layouts/dashboard/desktop', huge)).status).toBe(413);
  });

  it('includes the layouts in the backup export', async () => {
    const { api } = await signedIn();
    await api('PUT', '/layouts/dividends/desktop', { ...LAYOUT, order: [], hidden: ['x'], widths: {} });
    const exported = await api('GET', '/export/backup');
    expect(exported.status).toBe(200);
    expect(exported.body.layouts).toEqual([expect.objectContaining({ page: 'dividends', breakpoint: 'desktop', hidden: ['x'] })]);
  });
});
