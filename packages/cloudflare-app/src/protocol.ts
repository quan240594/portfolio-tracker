/** Header the Worker sets to the verified subject (`github:<id>`) of the signed-in owner. The Hub is only reachable through the Worker, which overwrites it. */
export const SUBJECT_HEADER = 'x-pt-subject';
export const REQUEST_ID_HEADER = 'x-request-id';
/** Internal path of the keep-alive call of the cron trigger; the Worker never forwards a client request to it. */
export const ARM_PATH = '/internal/arm';
/** The one named Hub instance (`idFromName`). */
export const HUB_NAME = 'hub';
/** Base of every URL the Worker uses towards the Hub (the host is meaningless, a Durable Object stub takes any). */
export const HUB_ORIGIN = 'https://hub.internal';

const OWNER_SUBJECT = /^github:([1-9]\d{0,15})$/;

/**
 * The user id of the application for a verified subject. The API only accepts `[A-Za-z0-9._-]` in a user id, so the
 * `github:<id>` of the identity port becomes `github-<id>`. Anything that is not a GitHub subject has no user id.
 */
export function userIdOfSubject(subject: string | null): string | undefined {
  const match = subject === null ? null : OWNER_SUBJECT.exec(subject);
  return match ? `github-${match[1]}` : undefined;
}

/** Removes the `/api` prefix the SPA's requests carry (the API itself routes on the bare path). */
export function stripApiPrefix(pathname: string): string {
  if (pathname === '/api') return '/';
  return pathname.startsWith('/api/') ? pathname.slice(4) : pathname;
}
