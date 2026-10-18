import { createPowertoolsLogger } from '@portfolio/aws';
import { setLogger } from '@portfolio/platform';
import { createAwsDeps } from './clients.js';
import { loadConfig } from './config.js';
import type { Deps } from './deps.js';
import { createHandler } from './lambda/handler.js';

setLogger(createPowertoolsLogger('portfolio-tracker-api'));

let deps: Deps | undefined;

/** Lambda entry point (API Gateway HTTP API, payload format 2.0). Clients are created once per container. */
export const handler = createHandler(() => (deps ??= createAwsDeps(loadConfig())));
