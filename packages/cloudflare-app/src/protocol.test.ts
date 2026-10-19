import { describe, expect, it } from 'vitest';
import { stripApiPrefix, userIdOfSubject } from './protocol.js';

describe('userIdOfSubject', () => {
  it('maps a GitHub subject to a user id the API accepts', () => {
    expect(userIdOfSubject('github:424242')).toBe('github-424242');
    expect(userIdOfSubject('github:424242')).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
  });

  it.each([null, '', 'github:', 'github:0', 'github:12ab', 'github:1/../2', 'google:5', ' github:5', 'github:5\n', 'github:12345678901234567'])('rejects %j', (subject) => {
    expect(userIdOfSubject(subject)).toBeUndefined();
  });
});

describe('stripApiPrefix', () => {
  it('removes only a leading /api segment', () => {
    expect(stripApiPrefix('/api')).toBe('/');
    expect(stripApiPrefix('/api/usage')).toBe('/usage');
    expect(stripApiPrefix('/usage')).toBe('/usage');
    expect(stripApiPrefix('/apix/usage')).toBe('/apix/usage');
    expect(stripApiPrefix('/x/api/usage')).toBe('/x/api/usage');
  });
});
