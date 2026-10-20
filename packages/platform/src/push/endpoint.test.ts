import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_HOSTS, MAX_ENDPOINT_LENGTH, parseAllowedHosts, validatePushEndpoint } from './endpoint.js';

describe('validatePushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGxx',
    'https://db5p.notify.windows.com/?token=abc',
    'https://FCM.GoogleAPIs.com/fcm/send/upper-case-host',
    'https://fcm.googleapis.com:443/fcm/send/explicit-default-port',
  ])('accepts %s', (endpoint) => {
    const result = validatePushEndpoint(endpoint);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc', 'https'],
    ['another scheme', 'ftp://fcm.googleapis.com/x', 'https'],
    ['an IPv4 literal', 'https://127.0.0.1/fcm/send/abc', 'IP address'],
    ['a cloud metadata IP', 'https://169.254.169.254/latest/meta-data', 'IP address'],
    ['an IPv4 in decimal form', 'https://2130706433/x', 'IP address'],
    ['an IPv6 literal', 'https://[::1]/x', 'IP address'],
    ['localhost', 'https://localhost/x', 'known push service'],
    ['a wrong host', 'https://example.com/fcm/send/abc', 'known push service'],
    ['a look-alike prefix host', 'https://fcm.googleapis.com.evil.example/x', 'known push service'],
    ['a look-alike suffix host', 'https://evilfcm.googleapis.com.attacker.net/x', 'known push service'],
    ['a host that merely ends like an allowed one', 'https://notfcm.googleapis.com/x', 'known push service'],
    ['userinfo that makes the real host a decoy', 'https://fcm.googleapis.com@evil.example/x', 'credentials'],
    ['userinfo before an allowed host', 'https://user:pass@fcm.googleapis.com/x', 'credentials'],
    ['a backslash trick', String.raw`https://evil.example\@fcm.googleapis.com/x`, 'known push service'],
    ['a custom port', 'https://fcm.googleapis.com:8443/x', 'default https port'],
    ['a port trick on a wrong host', 'https://evil.example:443@fcm.googleapis.com:80/x', 'credentials'],
    ['a trailing-dot host', 'https://fcm.googleapis.com./x', 'known push service'],
    ['the bare windows domain', 'https://notify.windows.com/x', 'known push service'],
    ['not a URL', 'not a url', 'valid URL'],
    ['an empty string', '', 'at most 2048'],
  ])('rejects %s', (_label, endpoint, reason) => {
    const result = validatePushEndpoint(endpoint);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain(reason);
  });

  it('rejects non-strings and endpoints that are too long', () => {
    expect(validatePushEndpoint(undefined).ok).toBe(false);
    expect(validatePushEndpoint(42).ok).toBe(false);
    expect(validatePushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(MAX_ENDPOINT_LENGTH)}`).ok).toBe(false);
  });

  it('honours a custom allow-list, exact hosts and wildcard subdomains', () => {
    expect(validatePushEndpoint('https://push.example.org/x', ['push.example.org']).ok).toBe(true);
    expect(validatePushEndpoint('https://a.push.example.org/x', ['push.example.org']).ok).toBe(false);
    expect(validatePushEndpoint('https://a.push.example.org/x', ['*.push.example.org']).ok).toBe(true);
    expect(validatePushEndpoint('https://push.example.org/x', ['*.push.example.org']).ok).toBe(false);
    expect(validatePushEndpoint('https://fcm.googleapis.com/x', ['push.example.org']).ok).toBe(false);
    expect(validatePushEndpoint('https://fcm.googleapis.com/x', ['']).ok).toBe(false);
  });
});

describe('parseAllowedHosts', () => {
  it('defaults to the known push services', () => {
    expect(parseAllowedHosts(undefined)).toBe(DEFAULT_PUSH_HOSTS);
    expect(parseAllowedHosts(' , ')).toBe(DEFAULT_PUSH_HOSTS);
  });

  it('splits, trims and lower-cases a configured list', () => {
    expect(parseAllowedHosts(' Push.Example.org, *.Other.example ')).toEqual(['push.example.org', '*.other.example']);
  });
});
