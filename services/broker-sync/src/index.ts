import { createHandler } from './app.js';
import { createAwsDeps } from './clients.js';
import { loadConfig } from './config.js';
import type { SyncDeps } from './sync.js';

let deps: SyncDeps | undefined;

/** Lambda entry point (EventBridge Scheduler `{"all":true}` or API invoke `{userId, portfolioId}`). */
export const handler = createHandler(() => (deps ??= createAwsDeps(loadConfig())));
