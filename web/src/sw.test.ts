import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = join(__dirname, '..', 'public');
const SOURCE = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');

type Listener = (event: Record<string, unknown>) => void;

/** Runs sw.js against a fake service-worker global and returns its listeners. */
function load() {
  const listeners = new Map<string, Listener>();
  const showNotification = vi.fn((_title: string, _options?: unknown) => Promise.resolve());
  const clients = { claim: vi.fn(() => Promise.resolve()), matchAll: vi.fn(() => Promise.resolve([] as unknown[])), openWindow: vi.fn(() => Promise.resolve(undefined)) };
  const scope = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients,
    registration: { scope: 'https://app.example.test/', showNotification },
    location: { origin: 'https://app.example.test' },
  };
  new Function('self', SOURCE)(scope);
  const waited: Promise<unknown>[] = [];
  const dispatch = (type: string, extra: Record<string, unknown> = {}) => {
    listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => waited.push(promise), ...extra });
    return Promise.all(waited);
  };
  return { listeners, scope, showNotification, clients, dispatch };
}

const pushEvent = (payload: unknown) => ({ data: { json: () => payload } });

describe('sw.js', () => {
  it('only listens for install, activate, push and notificationclick: no fetch handler, no caching', () => {
    const { listeners } = load();
    expect([...listeners.keys()].sort((a, b) => a.localeCompare(b))).toEqual(['activate', 'install', 'notificationclick', 'push']);
    expect(SOURCE).not.toMatch(/\bcaches\b|addEventListener\('fetch'|importScripts/);
  });

  it('takes control at once', async () => {
    const { scope, clients, dispatch } = load();
    await dispatch('install');
    await dispatch('activate');
    expect(scope.skipWaiting).toHaveBeenCalled();
    expect(clients.claim).toHaveBeenCalled();
  });

  it('shows the title, body, tag, icon and badge of the push and remembers the url', async () => {
    const { showNotification, dispatch } = load();
    await dispatch('push', pushEvent({ title: 'KMB declared $1.28 per share', body: 'Ex-date 06-11-2026', url: '/assets/KMB', tag: 'declared:KMB:2026-11-06' }));
    expect(showNotification).toHaveBeenCalledWith('KMB declared $1.28 per share', {
      body: 'Ex-date 06-11-2026',
      icon: 'https://app.example.test/notification-icon.png',
      badge: 'https://app.example.test/notification-badge.png',
      lang: 'en',
      data: { url: '/assets/KMB' },
      tag: 'declared:KMB:2026-11-06',
    });
  });

  it('shows something useful for a push without data or with garbage', async () => {
    const first = load();
    await first.dispatch('push', { data: undefined });
    expect(first.showNotification).toHaveBeenCalledWith('Portfolio Tracker', expect.objectContaining({ body: '', data: { url: '/' } }));
  });

  it('survives a payload that is not JSON', async () => {
    const { showNotification, dispatch } = load();
    await dispatch('push', { data: { json: () => { throw new SyntaxError('not json'); } } });
    expect(showNotification).toHaveBeenCalledWith('Portfolio Tracker', expect.not.objectContaining({ tag: expect.anything() }));
  });

  it.each([['https://evil.example/phish'], ['//evil.example'], ['javascript:alert(1)'], [42], [undefined]])('never opens %s: a tap goes to the app root', async (url) => {
    const { showNotification, dispatch } = load();
    await dispatch('push', pushEvent({ title: 't', url }));
    expect(showNotification.mock.calls[0]![1]).toMatchObject({ data: { url: '/' } });
  });

  it('opens a new window at the notification url when the app is not open', async () => {
    const { clients, dispatch } = load();
    const close = vi.fn();
    await dispatch('notificationclick', { notification: { close, data: { url: '/assets/KMB' } } });
    expect(close).toHaveBeenCalled();
    expect(clients.openWindow).toHaveBeenCalledWith('https://app.example.test/assets/KMB');
  });

  it('focuses an open window of the app and navigates it', async () => {
    const { clients, dispatch } = load();
    const navigate = vi.fn((_url: string) => Promise.resolve());
    const focused = { navigate };
    const open = { url: 'https://app.example.test/holdings', focus: vi.fn(() => Promise.resolve(focused)) };
    const foreign = { url: 'https://other.example/', focus: vi.fn() };
    clients.matchAll.mockResolvedValue([foreign, open]);
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: { url: '/calendar' } } });
    expect(open.focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('https://app.example.test/calendar');
    expect(foreign.focus).not.toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it('copes with a window that cannot navigate and with a notification without data', async () => {
    const { clients, dispatch } = load();
    clients.matchAll.mockResolvedValue([{ url: 'https://app.example.test/', focus: () => Promise.resolve({}) }]);
    await dispatch('notificationclick', { notification: { close: vi.fn() } });
    clients.matchAll.mockResolvedValue([{ url: 'https://app.example.test/', focus: () => Promise.resolve(undefined) }]);
    await dispatch('notificationclick', { notification: { close: vi.fn(), data: null } });
    expect(clients.openWindow).not.toHaveBeenCalled();
  });
});

describe('static hosting headers', () => {
  it('serves /sw.js without a cache and with the root scope', () => {
    const headers = readFileSync(join(PUBLIC, '_headers'), 'utf8');
    expect(headers).toMatch(/^\/sw\.js\n\s+Cache-Control: no-cache\n\s+Service-Worker-Allowed: \/$/m);
  });

  it('ships original, small icons', () => {
    for (const file of ['notification-icon.png', 'notification-badge.png']) {
      const bytes = readFileSync(join(PUBLIC, file));
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      expect(bytes.length).toBeLessThan(20_000);
    }
  });
});
