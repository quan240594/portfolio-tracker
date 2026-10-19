import { describe, expect, it } from 'vitest';
import { sanitizeReturnTo } from './return-to.js';

describe('sanitizeReturnTo', () => {
  it('keeps same-origin absolute paths, with query and fragment-free', () => {
    for (const ok of ['/', '/portfolios', '/portfolios/p1?tab=2', '/a/b%20c', '/%2f%2fevil.com', '/%5cevil']) {
      expect(sanitizeReturnTo(ok)).toBe(ok);
    }
  });

  it('falls back to / for open-redirect attempts and malformed values', () => {
    const bad = [
      undefined,
      '',
      '//evil.com',
      '///evil.com',
      '/\\evil.com',
      '\\evil.com',
      '/a\\b',
      'https://evil.com',
      'http://evil.com/x',
      'javascript:alert(1)',
      'evil.com',
      'relative/path',
      '%2f%2fevil.com',
      '/path\nSet-Cookie: x=1',
      '/path\r\n',
      '/a\tb',
      '/a\u0000b',
      '/a\u007fb',
      '/auth/login',
      '/auth',
      '/auth?x=1',
      `/${'a'.repeat(600)}`,
    ];
    for (const value of bad) expect(sanitizeReturnTo(value)).toBe('/');
  });
});
