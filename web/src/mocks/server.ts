import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { handlers } from './handlers';
import { api } from './utils';

// Like the AWS API, the mock API has no /usage route: the usage indicator stays hidden unless a test installs its own handler.
export const server = setupServer(http.get(api('/usage'), () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })), ...handlers);
