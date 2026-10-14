/** Public surface for other workspace packages (the API imports this, never the Lambda entry point). */
export { createHandler } from './app.js';
export { awsCommon, createAwsDeps, createDocClient } from './clients.js';
export * from './credentials.js';
export * from './errors.js';
export * from './memory-store.js';
export * from './redact.js';
export * from './store.js';
export * from './t212/client.js';
export { loadConfig, type Config } from './config.js';
