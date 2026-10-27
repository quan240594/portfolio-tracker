import { http, HttpResponse } from 'msw';
import type { PageLayout } from '@portfolio/shared';
import { apiUrl } from '../../api/client';
import { server } from '../../mocks/server';
import { api } from '../../mocks/utils';
import { apiLayoutStore, defaultLayoutStore, localLayoutStore } from './layoutStore';

const layout = (breakpoint: 'desktop' | 'mobile', order: string[] = ['b', 'a']): PageLayout => ({ version: 1, breakpoint, order, widths: { a: 'half' }, hidden: [] });

describe('localLayoutStore', () => {
  it('keeps layouts per page and breakpoint in this browser', async () => {
    expect(localLayoutStore.cached('dashboard')).toBeNull();
    await expect(localLayoutStore.load('dashboard')).resolves.toEqual({ desktop: null, mobile: null });

    await localLayoutStore.save('dashboard', 'desktop', layout('desktop'));
    expect(localLayoutStore.cached('dashboard')).toEqual({ desktop: layout('desktop'), mobile: null });
    await expect(localLayoutStore.load('goals')).resolves.toEqual({ desktop: null, mobile: null });

    await localLayoutStore.save('dashboard', 'desktop', null);
    expect(localLayoutStore.cached('dashboard')).toBeNull();
  });

  it('ignores damaged or mismatching entries', () => {
    localStorage.setItem('portfolio-tracker.layout.dashboard.desktop', '{not json');
    localStorage.setItem('portfolio-tracker.layout.dashboard.mobile', JSON.stringify(layout('desktop')));
    expect(localLayoutStore.cached('dashboard')).toBeNull();
    localStorage.setItem('portfolio-tracker.layout.dashboard.desktop', JSON.stringify({ version: 2 }));
    expect(localLayoutStore.cached('dashboard')).toBeNull();
  });

  it('rejects when the browser refuses to store', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    await expect(localLayoutStore.save('dashboard', 'desktop', layout('desktop'))).rejects.toThrow('quota');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw 'full';
    });
    await expect(localLayoutStore.save('dashboard', 'desktop', layout('desktop'))).rejects.toThrow('Could not store the layout in this browser');
  });
});

describe('apiLayoutStore', () => {
  it('round-trips through the layouts API and keeps a copy in this browser', async () => {
    await expect(apiLayoutStore.load('holdings')).resolves.toEqual({ desktop: null, mobile: null });
    await apiLayoutStore.save('holdings', 'mobile', layout('mobile'));

    await expect(apiLayoutStore.load('holdings')).resolves.toEqual({ desktop: null, mobile: layout('mobile') });
    expect(apiLayoutStore.cached('holdings')).toEqual({ desktop: null, mobile: layout('mobile') });

    await apiLayoutStore.save('holdings', 'mobile', null);
    await expect(apiLayoutStore.load('holdings')).resolves.toEqual({ desktop: null, mobile: null });
    expect(apiLayoutStore.cached('holdings')).toBeNull();
  });

  it('falls back to this browser when the deployment has no layouts API', async () => {
    server.use(
      http.get(api('/layouts/:page'), () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })),
      http.put(api('/layouts/:page/:breakpoint'), () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })),
    );
    await expect(apiLayoutStore.load('goals')).resolves.toEqual({ desktop: null, mobile: null });
    await apiLayoutStore.save('goals', 'desktop', layout('desktop'));
    await expect(apiLayoutStore.load('goals')).resolves.toEqual({ desktop: layout('desktop'), mobile: null });
  });

  it('reports other failures', async () => {
    server.use(
      http.get(api('/layouts/:page'), () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 })),
      http.put(api('/layouts/:page/:breakpoint'), () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 })),
    );
    await expect(apiLayoutStore.load('goals')).rejects.toThrow('Boom');
    await expect(apiLayoutStore.save('goals', 'desktop', layout('desktop'))).rejects.toThrow('Boom');
    expect(apiLayoutStore.cached('goals')).toBeNull();
  });

  it('still answers when the browser copy cannot be written', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    await expect(apiLayoutStore.save('goals', 'desktop', layout('desktop'))).resolves.toBeUndefined();
  });
});

describe('mock handlers', () => {
  it('validate the page, the breakpoint and the body, and DELETE clears both breakpoints', async () => {
    const put = (path: string, body: unknown) => fetch(apiUrl(path), { method: 'PUT', body: JSON.stringify(body) });
    expect((await fetch(apiUrl('/layouts/nope'))).status).toBe(400);
    expect((await put('/layouts/nope/desktop', null)).status).toBe(400);
    expect((await put('/layouts/goals/tablet', null)).status).toBe(400);
    expect((await put('/layouts/goals/desktop', { version: 9 })).status).toBe(400);
    expect((await fetch(apiUrl('/layouts/nope'), { method: 'DELETE' })).status).toBe(400);

    expect((await put('/layouts/goals/desktop', layout('desktop'))).status).toBe(204);
    expect((await put('/layouts/goals/mobile', layout('mobile'))).status).toBe(204);
    expect((await fetch(apiUrl('/layouts/goals'), { method: 'DELETE' })).status).toBe(204);
    await expect((await fetch(apiUrl('/layouts/goals'))).json()).resolves.toEqual({ desktop: null, mobile: null });
  });
});

describe('defaultLayoutStore', () => {
  it('uses this browser in the demo and the account otherwise', () => {
    expect(defaultLayoutStore(true)).toBe(localLayoutStore);
    expect(defaultLayoutStore(false)).toBe(apiLayoutStore);
  });
});
