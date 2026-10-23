import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, type Stack } from './browser.js';
import { LOGO_DEV_TEST_TOKEN, T212_BUCKET_HOST, T212_FAKE_BUCKET_HOST, T212_KEY, T212_SECRET } from './fakes.js';
import type { StartStack } from './suite.js';

const png = (response: Response) => response.arrayBuffer().then((buffer) => new Uint8Array(buffer));

async function signedIn(stack: Stack): Promise<Browser> {
  const browser = new Browser(stack);
  await browser.signIn();
  return browser;
}

/**
 * Company logos through the whole stack (Worker, sign-in, Hub, SQLite, the fake icon services of `FakeLogos`): written once and run
 * in Node and in workerd, like the rest of the app suite. Symbols are resolved by the curated table (`AAPL` -> apple.com), the
 * issuer prefix is not reachable without a stored profile, so the owner's override covers the "fix a miss" path.
 */
export function defineLogoSuite(label: string, start: StartStack): void {
  describe(`${label}: company logos`, () => {
    let stack: Stack;
    let owner: Browser;
    beforeAll(async () => {
      stack = await start({ logos: { LOGO_HOURLY_LIMIT: '3' } });
      owner = await signedIn(stack);
    });
    afterAll(() => stack?.dispose());

    it('needs the signed-in owner', async () => {
      const anonymous = await new Browser(stack).request('/api/logos/AAPL');
      expect(anonymous.status).toBe(401);
      expect(stack.logos.requests).toEqual([]);
    });

    it('fetches a logo once from the icon service, then serves it from the Hub with a private cache of a day and a validator', async () => {
      const first = await owner.request('/api/logos/AAPL');
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toBe('image/png');
      expect(first.headers.get('cache-control')).toBe('private, max-age=86400');
      expect(first.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await png(first)).toEqual(stack.logos.png);
      const etag = first.headers.get('etag')!;
      expect(etag).toMatch(/^"v2-google-[0-9a-f]{32}"$/);
      // Only the public domain reached the service: no symbol, no portfolio, no identity.
      expect(stack.logos.requests).toEqual(['https://www.google.com/s2/favicons?domain=apple.com&sz=128']);

      const again = await owner.request('/api/logos/AAPL');
      expect(again.status).toBe(200);
      const cached = await owner.request('/api/logos/AAPL', { headers: { 'if-none-match': etag } });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe('');
      expect(stack.logos.requests).toHaveLength(1);
    });

    it('shares one stored logo between the listings of one company', async () => {
      expect((await owner.request('/api/logos/AAPL.DE')).status).toBe(200);
      expect(stack.logos.requests).toHaveLength(1);
    });

    it('remembers a domain nobody has a logo for, so a missing logo is not fetched again', async () => {
      const before = stack.logos.requests.length;
      const first = await owner.request('/api/logos/MSFT');
      expect(first.status).toBe(404);
      expect(first.headers.get('cache-control')).toBe('private, max-age=3600');
      expect(((await first.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      const lookups = stack.logos.requests.length - before;
      expect(lookups).toBe(2);
      expect((await owner.request('/api/logos/MSFT')).status).toBe(404);
      expect(stack.logos.requests).toHaveLength(before + lookups);
    });

    it('answers 404 without any lookup for a symbol no domain is known for', async () => {
      const before = stack.logos.requests.length;
      expect((await owner.request('/api/logos/ZZZZ')).status).toBe(404);
      expect((await owner.request('/api/logos/not%20a%20symbol')).status).toBe(404);
      expect(stack.logos.requests).toHaveLength(before);
    });

    it('lets the owner fix a miss with the domain of the classification override', async () => {
      stack.logos.known.add('fixed.example.com');
      const put = await owner.request('/api/classification/ZZZZ', { method: 'PUT', body: { domain: 'https://www.Fixed.example.com/about' } });
      expect(put.status).toBe(200);
      expect(((await put.json()) as { override: { domain: string } }).override.domain).toBe('fixed.example.com');
      const fixed = await owner.request('/api/logos/ZZZZ');
      expect(fixed.status).toBe(200);
      expect(await png(fixed)).toEqual(stack.logos.png);
    });

    it('refuses a domain that is not a public host', async () => {
      const response = await owner.request('/api/classification/ZZZZ', { method: 'PUT', body: { domain: '10.0.0.1' } });
      expect(response.status).toBe(400);
    });

    it('stops looking up new domains after the hourly cap, with Retry-After, while stored logos keep being served', async () => {
      // Three lookups were used above (apple.com, microsoft.com, fixed.example.com).
      const limited = await owner.request('/api/logos/KO');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(limited.headers.get('cache-control')).toBe('no-store');
      expect((await owner.request('/api/logos/AAPL')).status).toBe(200);
    });
  });

  describe(`${label}: company logos from the Trading 212 bucket`, () => {
    const bucket = (ticker: string, host = T212_BUCKET_HOST) => `https://${host}/${ticker}.png`;

    /** An owner whose Trading 212 sync ran: the quote job stored the instrument tickers (`SAPd_EQ`, `AAPL_US_EQ`) on the held symbols' profiles. */
    async function withHoldings(options: Record<string, string>) {
      const stack = await start({ logos: options });
      const owner = await signedIn(stack);
      const post = (method: string, path: string, body?: unknown) => owner.request(`/api${path}`, { method, ...(body === undefined ? {} : { body }) });
      const created = (await (await post('POST', '/portfolios', { name: 'Logos' })).json()) as { portfolioId: string };
      const credentials = { portfolioId: created.portfolioId, apiKey: T212_KEY, apiSecret: T212_SECRET, environment: 'demo' };
      expect((await post('PUT', '/brokers/trading212', credentials)).status).toBe(204);
      expect((await post('POST', '/brokers/trading212/sync', { portfolioId: created.portfolioId })).status).toBe(202);
      await stack.drain();
      return { stack, owner };
    }

    it('fetches the logo of a held symbol from the bucket by its Trading 212 ticker, once, and keeps the domain sources for the rest', async () => {
      const { stack, owner } = await withHoldings({});
      try {
        const first = await owner.request('/api/logos/SAP.DE');
        expect(first.status).toBe(200);
        expect(first.headers.get('content-type')).toBe('image/png');
        expect(first.headers.get('cache-control')).toBe('private, max-age=86400');
        expect(await png(first)).toEqual(stack.logos.t212Png);
        const etag = first.headers.get('etag')!;
        expect(etag).toMatch(/^"v2-t212-[0-9a-f]{32}"$/);
        // One request: the ticker, nothing else (no symbol, no portfolio, no identity), and the domain sources were not needed.
        expect(stack.logos.requests).toEqual([bucket('SAPd_EQ')]);
        expect((await owner.request('/api/logos/SAP.DE')).status).toBe(200);
        expect((await owner.request('/api/logos/SAP.DE', { headers: { 'if-none-match': etag } })).status).toBe(304);
        expect(stack.logos.requests).toHaveLength(1);
        expect((await owner.request('/api/logos/AAPL')).status).toBe(200);
        expect(stack.logos.requests).toEqual([bucket('SAPd_EQ'), bucket('AAPL_US_EQ')]);
      } finally {
        await stack.dispose();
      }
    });

    it('falls back to the domain sources when the bucket has no logo, still one stored row', async () => {
      const { stack, owner } = await withHoldings({});
      try {
        stack.logos.tickers.delete('SAPd_EQ');
        stack.logos.known.add('sap.com');
        const response = await owner.request('/api/logos/SAP.DE');
        expect(response.status).toBe(200);
        expect(response.headers.get('etag')).toMatch(/^"v2-google-/);
        expect(stack.logos.requests).toEqual([bucket('SAPd_EQ'), 'https://www.google.com/s2/favicons?domain=sap.com&sz=128']);
        expect((await owner.request('/api/logos/SAP.DE')).status).toBe(200);
        expect(stack.logos.requests).toHaveLength(2);
      } finally {
        await stack.dispose();
      }
    });

    it('never contacts the bucket when LOGO_SOURCES leaves t212 out (the one-line switch-off)', async () => {
      const { stack, owner } = await withHoldings({ LOGO_SOURCES: 'google,duckduckgo' });
      try {
        stack.logos.known.add('sap.com');
        const response = await owner.request('/api/logos/SAP.DE');
        expect(response.status).toBe(200);
        expect(stack.logos.requests).toEqual(['https://www.google.com/s2/favicons?domain=sap.com&sz=128']);
      } finally {
        await stack.dispose();
      }
    });

    it('takes a base override only on an https amazonaws.com host, or any host with the test flag', async () => {
      const bad = await withHoldings({ LOGO_T212_BASE: 'http://fake-bucket.test' });
      try {
        expect((await bad.owner.request('/api/logos/SAP.DE')).status).toBe(200);
        expect(bad.stack.logos.requests).toEqual([bucket('SAPd_EQ')]);
      } finally {
        await bad.stack.dispose();
      }
      const flagged = await withHoldings({ LOGO_T212_BASE: 'http://fake-bucket.test', LOGO_ALLOW_ANY_HOST: '1' });
      try {
        expect((await flagged.owner.request('/api/logos/SAP.DE')).status).toBe(200);
        expect(flagged.stack.logos.requests).toEqual([`http://${T212_FAKE_BUCKET_HOST}/SAPd_EQ.png`]);
      } finally {
        await flagged.stack.dispose();
      }
    });
  });

  describe(`${label}: company logos switched off`, () => {
    it('answers 404 and never contacts a service when LOGO_SOURCES is off', async () => {
      const stack = await start({ logos: { LOGO_SOURCES: 'off' } });
      try {
        const owner = await signedIn(stack);
        expect((await owner.request('/api/logos/AAPL')).status).toBe(404);
        expect(stack.logos.requests).toEqual([]);
      } finally {
        await stack.dispose();
      }
    });

    it('does not use the token source without a token', async () => {
      const stack = await start({ logos: { LOGO_SOURCES: 'logodev' } });
      try {
        const owner = await signedIn(stack);
        expect((await owner.request('/api/logos/AAPL')).status).toBe(404);
        expect(stack.logos.requests).toEqual([]);
      } finally {
        await stack.dispose();
      }
    });

    it('asks the token source first when the Worker secret is set, and no other source once it answers', async () => {
      const stack = await start({ logos: { LOGO_DEV_TOKEN: LOGO_DEV_TEST_TOKEN } });
      try {
        const owner = await signedIn(stack);
        expect((await owner.request('/api/logos/AAPL')).status).toBe(200);
        expect(stack.logos.requests).toEqual([`https://img.logo.dev/apple.com?token=${LOGO_DEV_TEST_TOKEN}&size=128&format=png&fallback=404`]);
      } finally {
        await stack.dispose();
      }
    });
  });
}
