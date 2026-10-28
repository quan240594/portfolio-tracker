import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { NotificationsResponse, PushDeviceSummary } from '@portfolio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from '../mocks/server';
import { api } from '../mocks/utils';
import { endpointId } from '../features/notifications/push';
import { installPushEnvironment, TEST_ENDPOINT, type PushEnvironment } from '../test/pushEnvironment';
import { NotificationsView } from '../features/notifications/NotificationsView';
import { renderApp, renderWithProviders } from '../test/utils';

const SETTINGS = { types: { exDividend: true, declared: true, received: true, earnings: true }, exDividendDaysBefore: 2 };
const device = (overrides: Partial<PushDeviceSummary> = {}): PushDeviceSummary => ({ id: 'a'.repeat(32), label: 'Chrome on Android', service: 'fcm.googleapis.com', createdAt: '2026-10-01T08:00:00.000Z', failures: 0, ...overrides });
const state = (overrides: Partial<NotificationsResponse> = {}): NotificationsResponse => ({ available: true, configured: true, publicKey: 'B'.repeat(87), settings: SETTINGS, devices: [], maxDevices: 10, ...overrides });

let environment: PushEnvironment | undefined;
afterEach(() => {
  environment?.restore();
  environment = undefined;
});

/** Serves `current` and lets tests change it (what a later GET returns), recording the writes. */
function backend(initial: NotificationsResponse) {
  const store = { current: initial, puts: [] as unknown[], posts: [] as unknown[], deletes: [] as string[], tests: 0 };
  server.use(
    http.get(api('/notifications'), () => HttpResponse.json(store.current)),
    http.put(api('/notifications/settings'), async ({ request }) => {
      const patch = (await request.json()) as { types?: Partial<NotificationsResponse['settings']['types']>; exDividendDaysBefore?: number };
      store.puts.push(patch);
      store.current = { ...store.current, settings: { types: { ...store.current.settings.types, ...patch.types }, exDividendDaysBefore: patch.exDividendDaysBefore ?? store.current.settings.exDividendDaysBefore } };
      return HttpResponse.json(store.current.settings);
    }),
    http.post(api('/notifications/subscriptions'), async ({ request }) => {
      const body = (await request.json()) as { endpoint: string; label: string };
      store.posts.push(body);
      const created = device({ id: await endpointId(body.endpoint), label: body.label });
      store.current = { ...store.current, devices: [...store.current.devices, created] };
      return HttpResponse.json({ device: created, created: true }, { status: 201 });
    }),
    http.delete(api('/notifications/subscriptions/:id'), ({ params }) => {
      store.deletes.push(String(params.id));
      store.current = { ...store.current, devices: store.current.devices.filter((d) => d.id !== params.id) };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(api('/notifications/test'), () => {
      store.tests += 1;
      return HttpResponse.json({ results: store.current.devices.map((d) => ({ id: d.id, label: d.label, result: 'ok', removed: false })) });
    }),
  );
  return store;
}

const openPage = async () => {
  renderApp('/settings/notifications');
  return screen.findByRole('heading', { level: 1, name: 'Notifications' });
};

describe('Notifications page', () => {
  it('is not available in the demo build and asks the server nothing', async () => {
    let asked = false;
    server.use(http.get(api('/notifications'), () => {
      asked = true;
      return HttpResponse.json(state());
    }));
    renderWithProviders(<NotificationsView demo />);
    expect(await screen.findByRole('heading', { name: 'Notifications are not available' })).toBeInTheDocument();
    expect(screen.getByText(/The demo has no server/)).toBeInTheDocument();
    expect(asked).toBe(false);
  });

  it('is not available on a deployment without a push sender', async () => {
    await openPage();
    expect(await screen.findByRole('heading', { name: 'Notifications are not available' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable on this device' })).not.toBeInTheDocument();
  });

  it('says so when the server has no VAPID keys, and offers no enable button', async () => {
    environment = installPushEnvironment();
    backend(state({ configured: false, publicKey: undefined }));
    await openPage();
    expect(await screen.findByText(/not configured on the server/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable on this device' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a test notification' })).toBeDisabled();
  });

  it('shows an error with a retry when the state cannot be loaded', async () => {
    const user = userEvent.setup();
    server.use(http.get(api('/notifications'), () => HttpResponse.json({ error: { code: 'INTERNAL', message: 'Boom' } }, { status: 500 })));
    await openPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    backend(state());
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'This device' })).toBeInTheDocument();
  });

  it('explains an unsupported browser (iPhone outside a Home Screen app)', async () => {
    environment = installPushEnvironment({ noPushManager: true });
    backend(state());
    await openPage();
    expect(await screen.findByText(/This browser cannot receive push notifications/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable on this device' })).not.toBeInTheDocument();
  });

  it('asks for permission only when the button is clicked, then subscribes and registers the device', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment();
    const store = backend(state());
    await openPage();
    const enable = await screen.findByRole('button', { name: 'Enable on this device' });
    expect(environment.requestPermission).not.toHaveBeenCalled();
    expect(environment.serviceWorker.register).not.toHaveBeenCalled();
    await user.click(enable);
    expect(await screen.findByText('Notifications are on for this device.')).toBeInTheDocument();
    expect(environment.requestPermission).toHaveBeenCalledTimes(1);
    expect(store.posts).toEqual([{ endpoint: TEST_ENDPOINT, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) }, label: expect.any(String) }]);
    const devices = screen.getByRole('region', { name: 'Devices' });
    expect(within(devices).getByText(/\(this device\)/)).toBeInTheDocument();
    expect(within(devices).getByText(/fcm\.googleapis\.com · no delivery yet/)).toBeInTheDocument();
  });

  it('explains how to unblock the site when the permission is denied, and does not subscribe', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment({ prompt: 'denied' });
    const store = backend(state());
    await openPage();
    await user.click(await screen.findByRole('button', { name: 'Enable on this device' }));
    expect(await screen.findAllByText(/lock icon.*Permissions.*Notifications.*Allow/)).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Enable on this device' })).toBeDisabled();
    expect(environment.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(store.posts).toEqual([]);
  });

  it('starts blocked when the browser already denied notifications', async () => {
    environment = installPushEnvironment({ permission: 'denied' });
    backend(state());
    await openPage();
    expect(await screen.findByText(/lock icon/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable on this device' })).toBeDisabled();
  });

  it('shows a dismissed prompt as an error and lets the user try again', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment({ prompt: 'default' });
    backend(state());
    await openPage();
    await user.click(await screen.findByRole('button', { name: 'Enable on this device' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Notifications were not allowed');
    expect(screen.getByRole('button', { name: 'Enable on this device' })).toBeEnabled();
  });

  it('reports a server refusal of the subscription', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment();
    backend(state());
    server.use(http.post(api('/notifications/subscriptions'), () => HttpResponse.json({ error: { code: 'TOO_MANY_DEVICES', message: 'At most 10 devices can receive notifications; remove one first' } }, { status: 409 })));
    await openPage();
    await user.click(await screen.findByRole('button', { name: 'Enable on this device' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('At most 10 devices');
  });

  it('shows an unexpected failure as a message', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment();
    environment.requestPermission.mockRejectedValue('boom');
    backend(state());
    await openPage();
    await user.click(await screen.findByRole('button', { name: 'Enable on this device' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not enable notifications on this device.');
  });

  it('turns notifications off on this device: the server forgets it and the browser unsubscribes', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment({ subscribed: true, permission: 'granted' });
    const id = await endpointId(TEST_ENDPOINT);
    const store = backend(state({ devices: [device({ id })] }));
    await openPage();
    await user.click(await screen.findByRole('button', { name: 'Turn off on this device' }));
    expect(await screen.findByRole('button', { name: 'Enable on this device' })).toBeInTheDocument();
    expect(store.deletes).toEqual([id]);
    expect(environment.subscription.unsubscribe).toHaveBeenCalled();
  });

  it('shows a failure to turn off', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment({ subscribed: true, permission: 'granted' });
    const id = await endpointId(TEST_ENDPOINT);
    backend(state({ devices: [device({ id })] }));
    server.use(http.delete(api('/notifications/subscriptions/:id'), () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Device not found' } }, { status: 404 })));
    await openPage();
    await user.click(await screen.findByRole('button', { name: 'Turn off on this device' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Device not found');
  });

  it('toggles the types and the lead time, saving each change', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment();
    const store = backend(state());
    await openPage();
    const group = await screen.findByRole('group', { name: 'Notify me about' });
    const received = within(group).getByRole('checkbox', { name: /Dividend received/ });
    expect(received).toBeChecked();
    await user.click(received);
    await waitFor(() => expect(received).not.toBeChecked());
    await user.selectOptions(within(group).getByRole('combobox', { name: 'Ex-dividend reminder' }), '4');
    await waitFor(() => expect(within(group).getByRole('combobox')).toHaveValue('4'));
    expect(store.puts).toEqual([{ types: { received: false } }, { exDividendDaysBefore: 4 }]);
    await user.click(within(group).getByRole('checkbox', { name: /Ex-dividend reminders/ }));
    await waitFor(() => expect(within(group).getByRole('combobox')).toBeDisabled());
    expect(screen.getByText(/nothing is sent between 22:00 and 08:00/)).toBeInTheDocument();
    expect(within(group).getAllByRole('option').map((o) => o.textContent)).toEqual(['1 day before', '2 days before', '3 days before', '4 days before', '5 days before']);
  });

  it('shows a settings failure', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment();
    backend(state());
    server.use(http.put(api('/notifications/settings'), () => HttpResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid notification settings' } }, { status: 400 })));
    await openPage();
    await user.click(await screen.findByRole('checkbox', { name: /New dividend declared/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid notification settings');
  });

  it('lists the devices, tests them and removes one', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment();
    const store = backend(state({ devices: [device({ lastSuccessAt: '2026-10-19T07:30:00.000Z' }), device({ id: 'b'.repeat(32), label: 'Tablet', service: 'updates.push.services.mozilla.com', failures: 2 })] }));
    await openPage();
    const devices = await screen.findByRole('region', { name: 'Devices' });
    expect(within(devices).getByText(/last delivery 19-10-2026/)).toBeInTheDocument();
    expect(within(devices).getByText(/2 failed attempts in a row/)).toBeInTheDocument();
    await user.click(within(devices).getByRole('button', { name: 'Send a test notification' }));
    const result = await within(devices).findByRole('status');
    expect(result).toHaveTextContent('Chrome on Android: sent to the push service');
    expect(result).toHaveTextContent('Tablet: sent to the push service');
    expect(store.tests).toBe(1);
    await user.click(within(devices).getByRole('button', { name: 'Remove Tablet' }));
    await waitFor(() => expect(within(devices).queryByText('Tablet')).not.toBeInTheDocument());
    expect(store.deletes).toEqual(['b'.repeat(32)]);
  });

  it.each([
    ['gone', 'was removed'],
    ['rate-limited', 'slow down'],
    ['retryable', 'could not be reached'],
    ['rejected', 'refused'],
  ] as const)('explains a %s test result', async (result, text) => {
    const user = userEvent.setup();
    environment = installPushEnvironment();
    backend(state({ devices: [device()] }));
    server.use(http.post(api('/notifications/test'), () => HttpResponse.json({ results: [{ id: 'a'.repeat(32), label: 'Chrome on Android', result, removed: result === 'gone' }] })));
    await openPage();
    await user.click(await screen.findByRole('button', { name: 'Send a test notification' }));
    expect(await screen.findByRole('status')).toHaveTextContent(text);
  });

  it('shows a failed test', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment();
    backend(state({ devices: [device()] }));
    server.use(http.post(api('/notifications/test'), () => HttpResponse.json({ error: { code: 'PUSH_NOT_CONFIGURED', message: 'Push notifications are not configured' } }, { status: 503 })));
    await openPage();
    await user.click(await screen.findByRole('button', { name: 'Send a test notification' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not configured');
  });

  it('removing the device of this browser also drops the browser subscription', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment({ subscribed: true, permission: 'granted' });
    const id = await endpointId(TEST_ENDPOINT);
    backend(state({ devices: [device({ id, label: 'This phone' })] }));
    await openPage();
    await user.click(await screen.findByRole('button', { name: 'Remove This phone' }));
    await waitFor(() => expect(environment!.subscription.unsubscribe).toHaveBeenCalled());
  });

  it('disables the test button without devices and says nothing is registered', async () => {
    environment = installPushEnvironment();
    backend(state());
    await openPage();
    expect(await screen.findByText('No device receives notifications yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a test notification' })).toBeDisabled();
  });
});

const cardOrder = () => [...document.querySelectorAll<HTMLElement>('[data-card-id]')].map((el) => el.dataset.cardId);

describe('Notifications page layout', () => {
  it('keeps the default card order, the note after the cards and the customize toggle in the page header', async () => {
    environment = installPushEnvironment();
    backend(state());
    await openPage();
    await screen.findByRole('heading', { name: 'This device' });
    expect(cardOrder()).toEqual(['this-device', 'settings', 'devices']);
    const actions = document.querySelector<HTMLElement>('[data-page-header-actions]')!;
    expect(within(actions).getByRole('button', { name: 'Customize layout' })).toBeInTheDocument();
    const list = document.querySelector('[data-card-list]')!.parentElement!;
    expect(list.nextElementSibling).toBe(screen.getByRole('region', { name: 'About notifications' }));
  });

  it('moves the devices above the settings and hides this device', async () => {
    const user = userEvent.setup();
    environment = installPushEnvironment();
    backend(state({ devices: [device()] }));
    await openPage();
    await screen.findByRole('heading', { name: 'Devices' });
    await user.click(screen.getByRole('button', { name: 'Customize layout' }));
    await user.click(screen.getByRole('button', { name: 'Move Devices up' }));
    expect(cardOrder()).toEqual(['this-device', 'devices', 'settings']);

    await user.click(screen.getByRole('button', { name: 'Hide This device' }));
    expect(screen.queryByRole('heading', { name: 'This device' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Notify me about' })).toBeInTheDocument();
  });
});
