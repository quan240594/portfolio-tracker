import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_TTL_SECONDS, resolveGithubAuthConfig } from './config.js';
import { ORIGIN, SESSION_SECRET, testConfig } from '../../testing/github-auth.js';

const base = () => {
  const { fakeGithub: _unused, ...config } = testConfig();
  return config;
};

describe('resolveGithubAuthConfig', () => {
  it('applies defaults and normalises the origin', () => {
    const { now: _now, fetch: _fetch, ...rest } = base();
    const resolved = resolveGithubAuthConfig({ ...rest, origin: `${ORIGIN}/` });
    expect(resolved.sessionTtlSeconds).toBe(DEFAULT_SESSION_TTL_SECONDS);
    expect(DEFAULT_SESSION_TTL_SECONDS).toBe(604_800);
    expect(resolved.origin).toBe(ORIGIN);
    expect(typeof resolved.now()).toBe('number');
    expect(typeof resolved.fetch).toBe('function');
  });

  it('default fetch delegates to the global fetch', async () => {
    const { now: _now, fetch: _fetch, ...rest } = base();
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response('ok'))) as typeof fetch;
    try {
      expect(await (await resolveGithubAuthConfig(rest).fetch('https://example.test/x')).text()).toBe('ok');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('rejects missing or short session secrets without echoing them', () => {
    expect(() => resolveGithubAuthConfig({ ...base(), sessionSecret: '' })).toThrow(/sessionSecret is required/);
    expect(() => resolveGithubAuthConfig({ ...base(), sessionSecret: undefined as never })).toThrow(/sessionSecret is required/);
    const short = 'short-but-secret-31-characters-xx'.slice(0, 31);
    expect(short).toHaveLength(31);
    expect(() => resolveGithubAuthConfig({ ...base(), sessionSecret: short })).toThrow(/at least 32/);
    try {
      resolveGithubAuthConfig({ ...base(), sessionSecret: short });
    } catch (error) {
      expect(String(error)).not.toContain(short);
    }
    expect(() => resolveGithubAuthConfig({ ...base(), sessionSecret: 'x'.repeat(32) })).not.toThrow();
    expect(SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it('rejects an invalid owner id, client credentials, ttl and origins', () => {
    for (const ownerGithubId of [0, -1, 1.5, Number.NaN, '5' as never, 2 ** 60]) {
      expect(() => resolveGithubAuthConfig({ ...base(), ownerGithubId })).toThrow(/ownerGithubId/);
    }
    expect(() => resolveGithubAuthConfig({ ...base(), clientId: ' ' })).toThrow(/clientId/);
    expect(() => resolveGithubAuthConfig({ ...base(), clientSecret: '' })).toThrow(/clientSecret/);
    for (const sessionTtlSeconds of [0, -5, 1.5]) {
      expect(() => resolveGithubAuthConfig({ ...base(), sessionTtlSeconds })).toThrow(/sessionTtlSeconds/);
    }
    expect(() => resolveGithubAuthConfig({ ...base(), origin: 'not a url' })).toThrow(/absolute URL/);
    expect(() => resolveGithubAuthConfig({ ...base(), origin: '' })).toThrow(/origin is required/);
    expect(() => resolveGithubAuthConfig({ ...base(), origin: 'http://app.example.test' })).toThrow(/https/);
    expect(() => resolveGithubAuthConfig({ ...base(), origin: 'ftp://app.example.test' })).toThrow(/https/);
    for (const origin of [`${ORIGIN}/path`, `${ORIGIN}?q=1`, `${ORIGIN}#h`, 'https://user:pw@app.example.test']) {
      expect(() => resolveGithubAuthConfig({ ...base(), origin })).toThrow(/must not contain/);
    }
  });

  it('allows plain http for localhost development only', () => {
    expect(resolveGithubAuthConfig({ ...base(), origin: 'http://localhost:8787' }).origin).toBe('http://localhost:8787');
    expect(resolveGithubAuthConfig({ ...base(), origin: 'http://127.0.0.1:3000' }).origin).toBe('http://127.0.0.1:3000');
  });
});
