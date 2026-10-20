/*
 * Service worker of the personal deployment: it only shows dividend push notifications and opens the app when one is tapped.
 * It has no fetch handler and no cache: it never sits between the app and the network.
 */
'use strict';

const FALLBACK_TITLE = 'Portfolio Tracker';

/** A same-origin path from the payload, or "/" for anything else (an absolute URL, "//host", a scheme). */
function safePath(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function readPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    return {};
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  const title = typeof data.title === 'string' && data.title !== '' ? data.title : FALLBACK_TITLE;
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: new URL('notification-icon.png', self.registration.scope).href,
    badge: new URL('notification-badge.png', self.registration.scope).href,
    lang: 'en',
    data: { url: safePath(data.url) },
  };
  if (typeof data.tag === 'string' && data.tag !== '') options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(target);
      return open.focus().then((focused) => (focused && 'navigate' in focused ? focused.navigate(target) : undefined));
    }),
  );
});
