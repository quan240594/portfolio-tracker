import { describe, expect, it } from 'vitest';
import { readHubConfig, readWorkerConfig } from './config.js';
import { ORIGIN, OWNER_ID, TEST_CLIENT_ID, TEST_CLIENT_SECRET, TEST_SECRETS_KEY, TEST_SESSION_SECRET } from '../test/fakes.js';
import type { WorkerEnv } from './runtime.js';

const hubEnv = { SECRETS_KEY: TEST_SECRETS_KEY, ORIGIN };
const workerEnv = { ...hubEnv, OWNER_GITHUB_ID: String(OWNER_ID), GITHUB_CLIENT_ID: TEST_CLIENT_ID, GITHUB_CLIENT_SECRET: TEST_CLIENT_SECRET, SESSION_SECRET: TEST_SESSION_SECRET } as WorkerEnv;

describe('readHubConfig', () => {
  it('reads and normalises the variables', () => {
    expect(readHubConfig({ ...hubEnv, ORIGIN: ` ${ORIGIN}/some/path `, BASE_CURRENCY: 'usd', T212_SYMBOL_OVERRIDES: '{"A":"B","C":1}' })).toMatchObject({
      ok: true,
      config: { origin: ORIGIN, baseCurrency: 'USD', symbolOverrides: { A: 'B' } },
    });
  });

  it('hands the price service its keys and tuning from the string variables only', () => {
    const result = readHubConfig({ ...hubEnv, BASE_CURRENCY: 'usd', TWELVEDATA_API_KEY: ' td ', EU_REFRESH_HOURS: '9,12', HUB: {} } as never);
    expect(result).toMatchObject({ ok: true, config: { prices: { baseCurrency: 'USD', keys: { twelvedata: 'td', eodhd: undefined }, euRefreshHours: [9, 12] } } });
  });

  it('hands the logo service its sources, limits and optional token', () => {
    expect(readHubConfig({ ...hubEnv })).toMatchObject({ ok: true, config: { logos: { sources: ['t212', 'logodev', 'google', 'duckduckgo'], allowAnyHost: false, hourlyLimit: 30, negativeTtlDays: 7 } } });
    const result = readHubConfig({ ...hubEnv, LOGO_SOURCES: 'duckduckgo', LOGO_HOURLY_LIMIT: '5', LOGO_DEV_TOKEN: ' pk ', HUB: {} } as never);
    expect(result).toMatchObject({ ok: true, config: { logos: { sources: ['duckduckgo'], hourlyLimit: 5, logoDevToken: 'pk' } } });
  });

  it('defaults the currency to EUR and ignores unusable overrides', () => {
    for (const overrides of [undefined, '', 'not json', '[1]', 'null']) {
      expect(readHubConfig({ ...hubEnv, T212_SYMBOL_OVERRIDES: overrides })).toMatchObject({ ok: true, config: { baseCurrency: 'EUR', symbolOverrides: {} } });
    }
  });

  it('names every problem and never echoes a value', () => {
    const result = readHubConfig({ SECRETS_KEY: 'c2hvcnQ=', ORIGIN: 'ftp://nope', BASE_CURRENCY: 'euro' });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).toContain('SECRETS_KEY');
    expect(text).toContain('ORIGIN');
    expect(text).toContain('BASE_CURRENCY');
    expect(text).not.toContain('c2hvcnQ=');
    expect(readHubConfig({})).toMatchObject({ ok: false });
    expect(readHubConfig({ ...hubEnv, SECRETS_KEY: '!!!not base64!!!' })).toMatchObject({ ok: false });
    expect(readHubConfig({ ...hubEnv, ORIGIN: 'not a url' })).toMatchObject({ ok: false });
  });
});

describe('readHubConfig: Web Push', () => {
  it('has no keys by default: the feature is off, not an error', () => {
    expect(readHubConfig(hubEnv)).toMatchObject({ ok: true, config: { push: { allowedHosts: ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', '*.notify.windows.com'] } } });
    const result = readHubConfig(hubEnv);
    expect(result.ok && result.config.push.publicKey).toBeFalsy();
    expect(result.ok && result.config.push.privateKey).toBeFalsy();
  });

  it('reads the keys (trimmed) and a configured host list', () => {
    expect(readHubConfig({ ...hubEnv, VAPID_PUBLIC_KEY: ' pub ', VAPID_PRIVATE_KEY: ' priv\n', PUSH_ALLOWED_HOSTS: 'Push.Example.org, *.other.example' })).toMatchObject({
      ok: true,
      config: { push: { publicKey: 'pub', privateKey: 'priv', allowedHosts: ['push.example.org', '*.other.example'] } },
    });
    expect(readHubConfig({ ...hubEnv, VAPID_PUBLIC_KEY: '  ', VAPID_PRIVATE_KEY: '' })).toMatchObject({ ok: true, config: { push: {} } });
  });
});

describe('readWorkerConfig', () => {
  it('builds the sign-in configuration', () => {
    const result = readWorkerConfig(workerEnv);
    expect(result).toMatchObject({ ok: true, config: { ownerGithubId: OWNER_ID, origin: ORIGIN, clientId: TEST_CLIENT_ID } });
  });

  it('passes an injected fetch and clock on', () => {
    const fetchImpl = () => Promise.resolve(new Response());
    const result = readWorkerConfig(workerEnv, { fetch: fetchImpl, now: () => 5 });
    expect(result).toMatchObject({ ok: true, config: { fetch: fetchImpl } });
  });

  it.each([
    ['GITHUB_CLIENT_ID', ''],
    ['GITHUB_CLIENT_SECRET', undefined],
    ['SESSION_SECRET', 'too short'],
    ['OWNER_GITHUB_ID', 'the-owner'],
    ['OWNER_GITHUB_ID', '0'],
    ['ORIGIN', 'http://not-local.example'],
  ])('fails closed when %s is %j', (name, value) => {
    const result = readWorkerConfig({ ...workerEnv, [name]: value });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TEST_CLIENT_SECRET);
    expect(JSON.stringify(result)).not.toContain(TEST_SESSION_SECRET);
  });

  it('accepts http only for localhost', () => {
    expect(readWorkerConfig({ ...workerEnv, ORIGIN: 'http://localhost:8787' })).toMatchObject({ ok: true });
  });
});
