const MAX_LENGTH = 512;

function hasControlOrBackslash(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || char === '\\') return true;
  }
  return false;
}

/**
 * Accepts only a same-origin absolute path (one leading `/`, not `//`, no backslash, scheme or control character).
 * Anything else becomes `/`, so the sign-in redirect can never leave the site. Auth paths are refused too (no loops).
 */
export function sanitizeReturnTo(value: string | undefined): string {
  if (value === undefined || value.length > MAX_LENGTH) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || hasControlOrBackslash(value)) return '/';
  if (value === '/auth' || value.startsWith('/auth/') || value.startsWith('/auth?')) return '/';
  return value;
}
