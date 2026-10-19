import { describe, expect, it } from 'vitest';
import { isSameOrigin, requireSameOrigin } from './same-origin.js';

const origin = 'https://app.example.test';

describe('same-origin check', () => {
  it('lets safe methods through without any header', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(isSameOrigin({ method, headers: {} }, origin)).toBe(true);
      expect(requireSameOrigin({ method, headers: {} }, origin)).toBeUndefined();
    }
  });

  it('accepts a mutation whose Origin matches', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(requireSameOrigin({ method, headers: { origin } }, origin)).toBeUndefined();
    }
  });

  it('accepts Sec-Fetch-Site: same-origin when there is no Origin', () => {
    expect(isSameOrigin({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }, origin)).toBe(true);
  });

  it('rejects other origins, null, look-alikes, missing headers and cross-site hints with 403', () => {
    const cases: Record<string, string | undefined>[] = [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: `${origin}.evil.example` },
      { origin: 'http://app.example.test' },
      { origin: `${origin}/` },
      { origin: '' },
      {},
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'none' },
      // Origin decides when present, even if the browser hint says same-origin.
      { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
    ];
    for (const headers of cases) {
      const response = requireSameOrigin({ method: 'POST', headers }, origin);
      expect(response?.status, JSON.stringify(headers)).toBe(403);
      expect(response?.headers['cache-control']).toBe('no-store');
    }
  });

  it('works on Fetch Headers too', () => {
    expect(isSameOrigin({ method: 'POST', headers: new Headers({ origin }) }, origin)).toBe(true);
    expect(isSameOrigin({ method: 'POST', headers: new Headers() }, origin)).toBe(false);
    expect(isSameOrigin({ method: 'DELETE', headers: new Headers({ 'sec-fetch-site': 'same-origin' }) }, origin)).toBe(true);
  });
});
