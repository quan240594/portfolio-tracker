export const REDACTED = '[REDACTED]';

export interface Secrets {
  apiKey: string;
  apiSecret: string;
}

/** Replaces the key, the secret, their Basic-auth encoding and any `Basic <token>` in `text`. */
export function redact(text: string, { apiKey, apiSecret }: Secrets): string {
  let out = text.replaceAll(/Basic\s+[a-z0-9+/=_-]+/gi, `Basic ${REDACTED}`);
  const encoded = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  for (const needle of [encoded, apiKey, apiSecret]) {
    if (needle.length > 0) out = out.replaceAll(needle, REDACTED);
  }
  return out;
}
