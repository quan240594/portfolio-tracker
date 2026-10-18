/**
 * Platform-neutral surface for other workspace packages (the API imports this, never the Lambda entry point): nothing
 * here reaches a cloud SDK, so a Worker can bundle it. The AWS composition is `@portfolio/broker-sync/aws`.
 */
export { brokerSyncJob, createHandler, type HandlerResult } from './app.js';
export * from './credentials.js';
export * from './errors.js';
export * from './memory-store.js';
export * from './redact.js';
export * from './store.js';
export { syncAllJob, syncJob, runAll, runSync, type SyncDeps, type SyncLimits, type SyncRequest, type SyncResult } from './sync.js';
export * from './t212/client.js';
