import { MemoryItemStore } from '@portfolio/platform';
import { createApp } from './app.js';
import { fakeDeps, fakeEarningsDeps, fakeNotifyDeps } from './testing/fakes.js';
import { fakeEcb } from './testing/inflation-fakes.js';
import { defineApiScenarios } from './testing/scenarios.js';

const { deps } = fakeDeps({ notify: fakeNotifyDeps().notify, earnings: fakeEarningsDeps().earnings, inflation: { items: new MemoryItemStore(), fetch: fakeEcb().fetch } });
const app = createApp(() => deps);

// The platform-neutral scenarios on the in-memory dependencies; the same suite runs on LocalStack (api.int.test.ts) and on
// the Cloudflare Worker (packages/cloudflare-app).
defineApiScenarios('in-memory dependencies', {
  call: async (method, path, options = {}) => {
    const response = await app({
      method,
      path,
      query: options.query ?? {},
      headers: { 'content-type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: response.body ? JSON.parse(response.body) : undefined, headers: response.headers };
  },
});
