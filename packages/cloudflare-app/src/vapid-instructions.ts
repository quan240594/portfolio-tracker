import type { VapidKeys } from '@portfolio/platform';

/** What `pnpm run vapid:generate` prints: the two values and the exact commands that put them where they belong. */
export function vapidInstructions({ publicKey, privateKey }: VapidKeys): string {
  return [
    'VAPID key pair for dividend push notifications (generated locally, nothing was sent anywhere).',
    '',
    'Public key (not a secret; a plain variable, VAPID_PUBLIC_KEY):',
    publicKey,
    '',
    'Private key (SECRET: keep it out of git, chat and logs; Worker secret VAPID_PRIVATE_KEY):',
    privateKey,
    '',
    'Next steps:',
    '  1. pnpm --filter @portfolio/cloudflare-app exec wrangler secret put VAPID_PRIVATE_KEY   (paste the private key when asked)',
    '  2. VAPID_PUBLIC_KEY=<the public key above> ORIGIN=... OWNER_GITHUB_ID=... GITHUB_CLIENT_ID=... pnpm --filter @portfolio/cloudflare-app run deploy:app',
    '  3. Open the app, Notifications (account menu), and choose "Enable on this device".',
    '',
  ].join('\n');
}
