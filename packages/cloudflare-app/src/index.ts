import { createWorker } from './worker.js';

/** Entry point of `wrangler.jsonc` (`main`): the Worker (`fetch`, `scheduled`) and the Hub Durable Object class. */
export { Hub } from './hub.js';
export default createWorker();
