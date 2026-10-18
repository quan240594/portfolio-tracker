/** AWS composition of the sync: the adapters wired from the environment. Not part of the platform-neutral surface (`lib.ts`). */
export { createAwsDeps, createCredentialStore, createItemStore } from './clients.js';
export { loadConfig, type Config } from './config.js';
