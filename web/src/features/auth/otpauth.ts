const ISSUER = 'Portfolio Tracker';

/** otpauth:// URI that authenticator apps import via QR code. Built and rendered locally; the secret never leaves the page. */
export function otpauthUri(email: string, secret: string): string {
  const label = encodeURIComponent(`${ISSUER}:${email}`);
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(ISSUER)}`;
}

/** "ABCDEFGH" → "ABCD EFGH" for manual entry. */
export function formatSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}
