import { createHandler } from './app.js';
import { createAwsDeps } from './clients.js';
import { loadConfig } from './config.js';
import type { Deps } from './deps.js';

let deps: Deps | undefined;

/** Lambda entry point (API Gateway HTTP API, payload format 2.0). Clients are created once per container. */
export const handler = createHandler(() => (deps ??= createAwsDeps(loadConfig())));
