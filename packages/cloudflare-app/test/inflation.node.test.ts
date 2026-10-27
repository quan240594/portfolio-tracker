import { describe, expect, it } from 'vitest';
import { Browser } from './browser.js';
import { createNodeStack } from './node-stack.js';

// The monthly refresh and the stale-while-error rule need a clock that moves: only the Node stack has one.
const DAY_MS = 86_400_000;

async function signedIn() {
  const stack = await createNodeStack();
  const call = async (query: Record<string, string> = { area: 'U2' }) => {
    // a new sign-in every time: the session of an earlier one may be older than its lifetime on this clock
    const browser = new Browser(stack);
    await browser.signIn();
    const response = await browser.request('/api/inflation', { query });
    return { status: response.status, body: await response.json() };
  };
  return { stack, call };
}

describe('ECB inflation series on a moving clock (Node)', () => {
  it('asks the ECB once a month and keeps serving the cached series while it is unreachable', async () => {
    const { stack, call } = await signedIn();
    const first = await call();
    expect(first.body).toMatchObject({ area: 'U2', stale: false });
    stack.advance?.(10 * DAY_MS);
    expect((await call()).body.fetchedAt).toBe(first.body.fetchedAt);
    expect(stack.ecb.to('U2')).toHaveLength(1);

    stack.ecb.failWith = 503;
    stack.advance?.(21 * DAY_MS);
    const stale = await call();
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ stale: true, fetchedAt: first.body.fetchedAt, points: first.body.points });
    expect(stack.ecb.to('U2')).toHaveLength(2);
    // one more attempt is not made within the hour
    await call();
    expect(stack.ecb.to('U2')).toHaveLength(2);

    stack.ecb.failWith = null;
    stack.advance?.(3_600_000);
    const fresh = await call();
    expect(fresh.body).toMatchObject({ stale: false });
    expect(fresh.body.fetchedAt).not.toBe(first.body.fetchedAt);
    expect(stack.ecb.to('U2')).toHaveLength(3);
    await stack.dispose();
  });

  it('answers 502 while the ECB is down and nothing is cached', async () => {
    const { stack, call } = await signedIn();
    stack.ecb.failWith = 0;
    const down = await call({ area: 'NL' });
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('INFLATION_UNAVAILABLE');
    await stack.dispose();
  });
});
