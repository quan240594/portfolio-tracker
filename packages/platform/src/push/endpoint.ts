/**
 * SSRF guard for Web Push. A subscription endpoint is a URL the *client* hands us and the server later POSTs to, so it must
 * only ever point at a real push service: https, a host on an allow-list, no credentials, no custom port, no IP literal.
 * The check runs when a subscription is stored and again before every send (the list may have changed, the item may be old).
 */

/** Push services of the browsers that implement Web Push: Chrome/Edge (FCM), Firefox, Safari, legacy Edge (WNS). `*.` = subdomains only. */
export const DEFAULT_PUSH_HOSTS: readonly string[] = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '*.notify.windows.com'];

export const MAX_ENDPOINT_LENGTH = 2048;

export type EndpointCheck = { ok: true; url: URL } | { ok: false; reason: string };

const IPV4_LIKE = /^[\d.]+$/;

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1)) && hostname.length > pattern.length - 1;
    return pattern !== '' && hostname === pattern;
  });
}

/** Parses `PUSH_ALLOWED_HOSTS` (comma separated); an empty or missing value means the defaults. */
export function parseAllowedHosts(raw: string | undefined): readonly string[] {
  const hosts = (raw ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
  return hosts.length > 0 ? hosts : DEFAULT_PUSH_HOSTS;
}

/** Validates a subscription endpoint against the allow-list. The reason names the rule, never the endpoint. */
export function validatePushEndpoint(endpoint: unknown, allowedHosts: readonly string[] = DEFAULT_PUSH_HOSTS): EndpointCheck {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) return { ok: false, reason: 'The endpoint must be a URL of at most 2048 characters' };
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: 'The endpoint is not a valid URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'The endpoint must use https' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'The endpoint must not contain credentials' };
  if (url.port !== '') return { ok: false, reason: 'The endpoint must use the default https port' };
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[') || IPV4_LIKE.test(host)) return { ok: false, reason: 'The endpoint must use a host name, not an IP address' };
  if (!hostAllowed(host, allowedHosts)) return { ok: false, reason: 'The endpoint is not a known push service' };
  return { ok: true, url };
}
