/**
 * Platform-neutral surface of the API: what a platform adapter (the Lambda handler, a Cloudflare Worker) imports.
 * Nothing exported here depends on a cloud SDK; the AWS composition lives in `clients.ts` and `lambda/`.
 */
export { createApp, errorToResult } from './app.js';
export type { BrokerDeps } from './broker-deps.js';
export { verifyWithTrading212 } from './broker-deps.js';
export { loadConfig, type Config } from './config.js';
export type { Deps, EarningsDeps, HistorySymbolDeps, InflationDeps, RouteContext } from './deps.js';
export { EcbInflationSource, InflationSourceError, type InflationFetch, type InflationSource } from './inflation/source.js';
export { InflationService, InflationUnavailableError } from './inflation/service.js';
export { ItemManagementRepository, type ManagementRepository } from './management-repository.js';
export { ItemRepository, type Repository } from './repository.js';
export type { ConfiguredPush, NotifyDeps, PushConfig } from './notifications/deps.js';
export { ItemNotificationRepository, type NotificationRepository } from './notifications/repository.js';
export { MAX_PUSHES_PER_USER_STEP, backedOff, notifyDividendsJob, planNotifications, type NotifyJobDeps, type NotifyPayload, type NotifyResult } from './notifications/job.js';
export { baselineUser } from './notifications/data.js';
