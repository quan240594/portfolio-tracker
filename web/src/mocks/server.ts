import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { handlers } from './handlers';
import { api } from './utils';

const NOTIFICATIONS_UNAVAILABLE = { available: false, configured: false, settings: { types: { exDividend: true, declared: true, received: true }, exDividendDaysBefore: 2 }, devices: [], maxDevices: 10 };

// Like the AWS API, the mock API has no /usage route: the usage indicator stays hidden unless a test installs its own handler.
// ... nor an alarm log (the Account menu then shows no Diagnostics entry), nor a notification sender: the Account menu then shows no Notifications entry.
export const server = setupServer(
  http.get(api('/notifications'), () => HttpResponse.json(NOTIFICATIONS_UNAVAILABLE)),
  http.get(api('/diagnostics/alarms'), () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })),
  http.get(api('/usage'), () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })),
  ...handlers,
);
