import { createPushSender } from '@portfolio/platform';
import type { PushConfig } from '@portfolio/api';
import type { HubConfig } from './config.js';

/**
 * The push sender of the Hub: VAPID-signed Web Push over `fetchFn` (the alarm's counted `fetch` in jobs, so every push is one subrequest),
 * with the app's own origin as the VAPID subject. Without both keys the feature is off: `{ configured: false }`, never an error.
 */
export function pushConfig(config: HubConfig, fetchFn: typeof fetch): PushConfig {
  const { publicKey, privateKey, allowedHosts } = config.push;
  if (publicKey === undefined || privateKey === undefined) return { configured: false };
  const send = createPushSender({ vapid: { publicKey, privateKey, subject: config.origin }, fetch: fetchFn, allowedHosts });
  return { configured: true, publicKey, send, allowedHosts };
}
