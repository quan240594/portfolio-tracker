import type { PushSender } from '@portfolio/platform';
import type { NotificationRepository } from './repository.js';

/** What the push sender needs: the VAPID public key the browser subscribes with and the sender itself. */
export type PushConfig =
  | { configured: false }
  | { configured: true; publicKey: string; send: PushSender; allowedHosts?: readonly string[] };

/** The push sender with its VAPID keys in place. */
export type ConfiguredPush = Extract<PushConfig, { configured: true }>;

/**
 * The notification feature of a deployment. Absent on a deployment without a push sender (the AWS demo), which then answers
 * `GET /notifications` with `available: false` and the web app hides the feature.
 */
export interface NotifyDeps {
  repo: NotificationRepository;
  push: PushConfig;
}
