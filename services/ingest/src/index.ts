import { createHandler } from './app.js';
import { createAwsDeps } from './clients.js';
import { loadConfig } from './config.js';
import type { IngestDeps } from './processor.js';

let deps: IngestDeps | undefined;

/** Lambda entry point: SQS event source mapping with ReportBatchItemFailures enabled. */
export const handler = createHandler(() => (deps ??= createAwsDeps(loadConfig())));
