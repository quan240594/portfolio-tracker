import { createHash } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';

// Dividend push notifications in the GitHub-sign-in build. The Worker is a route mock (state kept here) and the browser's push stack
// (service worker, Push API, Notification) is a stub installed before the page loads, so no real push service is ever contacted.
const NOW = new Date('2026-10-19T10:00:00Z');
const OWNER = 'octo-owner';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e2e-device';
// The server names a device by the SHA-256 prefix of its endpoint; the page recognises "this device" the same way.
const DEVICE_ID = createHash('sha256').update(ENDPOINT).digest('hex').slice(0, 32);

test.use({ timezoneId: 'Europe/Amsterdam', locale: 'en-GB' });

interface Device {
  id: string;
  label: string;
  service: string;
  createdAt: string;
  lastSuccessAt?: string;
  failures: number;
}

interface Backend {
  available: boolean;
  configured: boolean;
  devices: Device[];
  settings: { types: { exDividend: boolean; declared: boolean; received: boolean }; exDividendDaysBefore: number };
  puts: unknown[];
  posts: unknown[];
  deletes: string[];
  tests: number;
}

async function mockWorker(page: Page, overrides: Partial<Backend> = {}): Promise<Backend> {
  const state: Backend = {
    available: true,
    configured: true,
    devices: [],
    settings: { types: { exDividend: true, declared: true, received: true }, exDividendDaysBefore: 2 },
    puts: [],
    posts: [],
    deletes: [],
    tests: 0,
    ...overrides,
  };
  const isPath = (prefix: string) => (url: URL) => url.pathname.startsWith(prefix);

  await page.route(isPath('/auth/'), (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/session') return route.fulfill({ json: { authenticated: true, login: OWNER }, headers: { 'cache-control': 'no-store' } });
    return route.fulfill({ status: 404 });
  });

  await page.route(isPath('/api/'), async (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (pathname === '/api/notifications' && method === 'GET') {
      return route.fulfill({
        json: { available: state.available, configured: state.configured, ...(state.configured ? { publicKey: 'B'.repeat(87) } : {}), settings: state.settings, devices: state.devices, maxDevices: 10 },
      });
    }
    if (pathname === '/api/notifications/settings' && method === 'PUT') {
      const patch = request.postDataJSON() as { types?: Partial<Backend['settings']['types']>; exDividendDaysBefore?: number };
      state.puts.push(patch);
      state.settings = { types: { ...state.settings.types, ...patch.types }, exDividendDaysBefore: patch.exDividendDaysBefore ?? state.settings.exDividendDaysBefore };
      return route.fulfill({ json: state.settings });
    }
    if (pathname === '/api/notifications/subscriptions' && method === 'POST') {
      const body = request.postDataJSON() as { endpoint: string; label: string };
      state.posts.push(body);
      const device: Device = { id: DEVICE_ID, label: body.label, service: 'fcm.googleapis.com', createdAt: '2026-10-19T10:00:00.000Z', failures: 0 };
      state.devices = [device];
      return route.fulfill({ status: 201, json: { device, created: true } });
    }
    if (pathname.startsWith('/api/notifications/subscriptions/') && method === 'DELETE') {
      state.deletes.push(pathname.split('/').at(-1) ?? '');
      state.devices = [];
      return route.fulfill({ status: 204 });
    }
    if (pathname === '/api/notifications/test' && method === 'POST') {
      state.tests++;
      return route.fulfill({ json: { results: state.devices.map((device) => ({ id: device.id, label: device.label, result: 'ok', removed: false })) } });
    }
    if (pathname === '/api/portfolios') return route.fulfill({ json: { portfolios: [] } });
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found' } } });
  });
  return state;
}

interface PushStubOptions {
  prompt?: 'granted' | 'denied';
  permission?: 'default' | 'denied';
}

/** Stands in for the browser's push stack. `window.__push` records what the app did with it. */
async function stubPush(page: Page, { prompt = 'granted', permission = 'default' }: PushStubOptions = {}) {
  await page.addInitScript(
    ({ endpoint, promptResult, initialPermission }) => {
      const record = { registered: [] as string[], prompts: 0, subscribeCalls: 0, unsubscribed: 0 };
      (window as unknown as { __push: typeof record }).__push = record;
      let subscribed = false;
      const subscription = {
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }),
        unsubscribe: () => {
          subscribed = false;
          record.unsubscribed++;
          return Promise.resolve(true);
        },
      };
      const registration = {
        pushManager: {
          getSubscription: () => Promise.resolve(subscribed ? subscription : null),
          subscribe: () => {
            record.subscribeCalls++;
            subscribed = true;
            return Promise.resolve(subscription);
          },
        },
      };
      const serviceWorker = {
        register: (url: string) => {
          record.registered.push(url);
          return Promise.resolve(registration);
        },
        getRegistration: () => Promise.resolve(registration),
        ready: Promise.resolve(registration),
      };
      Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
      Object.defineProperty(window, 'PushManager', { value: class PushManager {}, configurable: true, writable: true });
      Object.defineProperty(window, 'Notification', {
        value: Object.assign(function Notification() {}, {
          permission: initialPermission,
          requestPermission: () => {
            record.prompts++;
            return Promise.resolve(promptResult);
          },
        }),
        configurable: true,
        writable: true,
      });
    },
    { endpoint: ENDPOINT, promptResult: prompt, initialPermission: permission },
  );
}

const pushRecord = (page: Page) => page.evaluate(() => (window as unknown as { __push: { registered: string[]; prompts: number; subscribeCalls: number; unsubscribed: number } }).__push);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

for (const viewport of [
  { name: '1280 px', width: 1280, height: 900 },
  { name: '320 px', width: 320, height: 800 },
]) {
  test.describe(`Notifications at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('enable on this device, change the settings, test and remove it', async ({ page }) => {
      await stubPush(page);
      const backend = await mockWorker(page);
      await page.goto('/');
      await page.getByRole('button', { name: 'Account' }).click();
      await page.getByRole('link', { name: 'Notifications' }).click();

      await expect(heading(page, 'Notifications')).toBeVisible();
      await expect(page).toHaveURL(/\/settings\/notifications$/);
      await expect(page).toHaveTitle(/Notifications · Portfolio Tracker/);
      expect((await pushRecord(page)).registered).toEqual(['/sw.js']);
      // Nothing is requested until the button is pressed.
      expect((await pushRecord(page)).prompts).toBe(0);

      await page.getByRole('button', { name: 'Enable on this device' }).click();
      await expect(page.getByText('Notifications are on for this device.')).toBeVisible();
      expect(await pushRecord(page)).toMatchObject({ prompts: 1, subscribeCalls: 1 });
      expect(backend.posts).toHaveLength(1);
      expect(backend.posts[0]).toMatchObject({ endpoint: ENDPOINT, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
      await expect(page.getByRole('region', { name: 'Devices' })).toContainText('(this device)');

      const group = page.getByRole('group', { name: 'Notify me about' });
      await group.getByRole('checkbox', { name: /Dividend received/ }).uncheck();
      await expect.poll(() => backend.puts).toContainEqual({ types: { received: false } });
      await group.getByRole('combobox', { name: 'Ex-dividend reminder' }).selectOption('4');
      await expect.poll(() => backend.puts).toContainEqual({ exDividendDaysBefore: 4 });
      await expect(group.getByRole('combobox')).toHaveValue('4');
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await page.getByRole('button', { name: 'Send a test notification' }).click();
      await expect(page.getByRole('region', { name: 'Devices' }).getByRole('status')).toContainText('sent to the push service');
      expect(backend.tests).toBe(1);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await page.getByRole('button', { name: /^Remove / }).click();
      await expect(page.getByText('No device receives notifications yet.')).toBeVisible();
      expect(backend.deletes).toEqual([DEVICE_ID]);
      expect((await pushRecord(page)).unsubscribed).toBe(1);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('explains how to unblock the site when the permission is denied', async ({ page }) => {
      await stubPush(page, { prompt: 'denied' });
      const backend = await mockWorker(page);
      await page.goto('/settings/notifications');
      await page.getByRole('button', { name: 'Enable on this device' }).click();
      await expect(page.getByText(/lock icon.*Permissions.*Notifications.*Allow/).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enable on this device' })).toBeDisabled();
      expect(backend.posts).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });

    test('says the server is not configured and offers no enable button', async ({ page }) => {
      await stubPush(page);
      await mockWorker(page, { configured: false });
      await page.goto('/settings/notifications');
      await expect(page.getByText(/not configured on the server/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enable on this device' })).toHaveCount(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  });
}

test.describe('Notifications are hidden where the deployment cannot send them', () => {
  test('no Account menu entry, and the page says it is not available', async ({ page }) => {
    await stubPush(page);
    await mockWorker(page, { available: false });
    await page.goto('/');
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Notifications' })).toHaveCount(0);
    await page.goto('/settings/notifications');
    await expect(page.getByRole('heading', { name: 'Notifications are not available' })).toBeVisible();
  });

  test('a browser without push support gets an explanation', async ({ page }) => {
    await mockWorker(page);
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'PushManager');
    });
    await page.goto('/settings/notifications');
    await expect(page.getByText(/cannot receive push notifications/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enable on this device' })).toHaveCount(0);
  });
});
